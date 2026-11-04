//! The agent's state and its two links. One host session at a time (a newer connection replaces the older one);
//! one box session. Host requests run as spawned operations serialized by `op_lock`, so a long configure never
//! overlaps a suspend or a volume freeze. `ping` answers at once.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{split, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::AbortHandle;
use tokio::time::{interval, sleep, timeout, MissedTickBehavior};

use crate::args::Config;
use crate::configure::{self, read_clone_id};
use crate::gpu;
use crate::http::wait_healthy;
use crate::link::{read_frame, reply, write_frame, Outgoing};
use crate::protocol::{
    valid_id, BoxActivity, BoxToGuest, ConfigureArgs, GpuState, GuestToBox, GuestToHost,
    HostToGuest, ReplyBody, GUEST_PROTOCOL, STATUS_INTERVAL_MS,
};
use crate::status::read_pressure;
use crate::system::{log, sync_all, Res, System};

/// Box waits, each below the host's own timeout for the op that performs them (see `GUEST_REPLY_TIMEOUT_MS`).
const QUIESCE_WAIT: Duration = Duration::from_secs(20);
const FREEZE_QUIESCE_WAIT: Duration = Duration::from_secs(10);
const RESUME_WAIT: Duration = Duration::from_secs(10);
const RESUME_HEALTH_WAIT: Duration = Duration::from_secs(40);
const RELEASE_WAIT: Duration = Duration::from_secs(10);
/// How long a frozen volume stays frozen without a `thawVolume`.
const FREEZE_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_FLUSH_WAIT: Duration = Duration::from_secs(5);

pub struct App {
    pub cfg: Config,
    pub sys: System,
    boot_id: String,
    op_lock: AsyncMutex<()>,
    state: Mutex<State>,
}

struct State {
    next_link: u64,
    configured: bool,
    clone_id: Option<String>,
    gpu: GpuState,
    gpu_pci: Option<String>,
    freeze_seq: u64,
    frozen: Option<u64>,
    host: Option<HostLink>,
    host_task: Option<AbortHandle>,
    box_link: Option<Arc<BoxLink>>,
}

#[derive(Clone)]
struct HostLink {
    id: u64,
    tx: mpsc::Sender<Outgoing<GuestToHost>>,
}

pub struct BoxLink {
    tx: mpsc::Sender<Outgoing<GuestToBox>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ReplyBody>>>,
    activity: Mutex<Option<BoxActivity>>,
    requests: AtomicU64,
}

impl BoxLink {
    fn new(tx: mpsc::Sender<Outgoing<GuestToBox>>) -> Self {
        Self {
            tx,
            pending: Mutex::new(HashMap::new()),
            activity: Mutex::new(None),
            requests: AtomicU64::new(0),
        }
    }

    fn next_request_id(&self) -> String {
        format!("guest-{}", self.requests.fetch_add(1, Ordering::Relaxed))
    }
}

impl App {
    pub fn new(cfg: Config, sys: System) -> Res<Arc<Self>> {
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|e| format!("read boot id: {e}"))?
            .trim()
            .to_string();
        let clone_id = read_clone_id(&cfg.machine_id);
        let configured = cfg.box_env_file.exists();
        Ok(Arc::new(Self {
            cfg,
            sys,
            boot_id,
            op_lock: AsyncMutex::new(()),
            state: Mutex::new(State {
                next_link: 0,
                configured,
                clone_id,
                gpu: GpuState::None,
                gpu_pci: None,
                freeze_seq: 0,
                frozen: None,
                host: None,
                host_task: None,
                box_link: None,
            }),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    fn new_link_id(&self) -> u64 {
        let mut st = self.lock();
        st.next_link += 1;
        st.next_link
    }

    fn gpu_snapshot(&self) -> (GpuState, Option<String>) {
        let st = self.lock();
        (st.gpu, st.gpu_pci.clone())
    }
}

/// Takes over the host link: the previous host session, if any, is aborted.
pub fn serve_host<S>(app: &Arc<App>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let id = app.new_link_id();
    let task = tokio::spawn(host_session(app.clone(), stream, id));
    let previous = app.lock().host_task.replace(task.abort_handle());
    if let Some(previous) = previous {
        previous.abort();
    }
}

pub fn serve_box<S>(app: &Arc<App>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(box_session(app.clone(), stream));
}

async fn host_session<S>(app: Arc<App>, stream: S, id: u64)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (rd, mut wr) = split(stream);
    let mut rd = BufReader::new(rd);
    let (tx, mut rx) = mpsc::channel::<Outgoing<GuestToHost>>(32);
    let hello = {
        let st = app.lock();
        GuestToHost::Hello {
            protocol: GUEST_PROTOCOL,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            boot_id: app.boot_id.clone(),
            clone_id: st.clone_id.clone(),
            configured: st.configured,
        }
    };
    app.lock().host = Some(HostLink { id, tx: tx.clone() });

    let mut pending = Vec::new();
    let mut tick = interval(Duration::from_millis(STATUS_INTERVAL_MS));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let outcome: io::Result<()> = async {
        write_frame(&mut wr, &hello).await?;
        loop {
            tokio::select! {
                line = read_frame(&mut rd, &mut pending) => match line? {
                    Some(line) => dispatch_host(&app, &tx, &line),
                    None => return Ok(()),
                },
                Some(out) = rx.recv() => {
                    write_frame(&mut wr, &out.frame).await?;
                    if let Some(flushed) = out.flushed {
                        let _ = flushed.send(());
                    }
                }
                _ = tick.tick() => {
                    if let Some(status) = status_frame(&app) {
                        write_frame(&mut wr, &status).await?;
                    }
                }
            }
        }
    }
    .await;

    {
        let mut st = app.lock();
        if st.host.as_ref().is_some_and(|host| host.id == id) {
            st.host = None;
        }
    }
    match outcome {
        Ok(()) => log("host disconnected"),
        Err(e) => log(format!("host link closed: {e}")),
    }
}

async fn box_session<S>(app: Arc<App>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (rd, mut wr) = split(stream);
    let mut rd = BufReader::new(rd);
    let (tx, mut rx) = mpsc::channel::<Outgoing<GuestToBox>>(32);
    let link = Arc::new(BoxLink::new(tx.clone()));
    app.lock().box_link = Some(link.clone());
    let (state, pci_address) = app.gpu_snapshot();
    let _ = tx.try_send(Outgoing::new(GuestToBox::GpuState { state, pci_address }));

    let mut pending = Vec::new();
    let outcome: io::Result<()> = async {
        loop {
            tokio::select! {
                line = read_frame(&mut rd, &mut pending) => match line? {
                    Some(line) => dispatch_box(&app, &link, &line),
                    None => return Ok(()),
                },
                Some(out) = rx.recv() => write_frame(&mut wr, &out.frame).await?,
            }
        }
    }
    .await;

    {
        let mut st = app.lock();
        if st
            .box_link
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &link))
        {
            st.box_link = None;
        }
    }
    // Dropping the waiters makes every pending request fail at once.
    link.pending.lock().unwrap().clear();
    match outcome {
        Ok(()) => log("box disconnected"),
        Err(e) => log(format!("box link closed: {e}")),
    }
}

fn dispatch_host(app: &Arc<App>, tx: &mpsc::Sender<Outgoing<GuestToHost>>, line: &[u8]) {
    let frame: HostToGuest = match serde_json::from_slice(line) {
        Ok(frame) => frame,
        Err(e) => {
            log(format!("ignoring malformed host frame: {e}"));
            return;
        }
    };
    let id = match frame.id() {
        Some(id) if valid_id(id) => id.to_string(),
        Some(_) => {
            log("ignoring host frame with an invalid request id");
            return;
        }
        None => return,
    };
    match frame {
        HostToGuest::Ping { .. } => {
            let tx = tx.clone();
            tokio::spawn(async move { send_host(&tx, reply(id, Ok(()))).await });
        }
        HostToGuest::Shutdown { .. } => spawn_shutdown(app.clone(), tx.clone(), id),
        HostToGuest::Configure(args) => spawn_op(app, tx, id, move |app| async move {
            configure_op(&app, *args).await
        }),
        HostToGuest::PrepareSuspend { .. } => {
            spawn_op(
                app,
                tx,
                id,
                |app| async move { prepare_suspend(&app).await },
            )
        }
        HostToGuest::Resumed { wall_clock_ms, .. } => {
            spawn_op(app, tx, id, move |app| async move {
                resumed(&app, wall_clock_ms).await
            })
        }
        HostToGuest::FreezeVolume { .. } => {
            spawn_op(app, tx, id, |app| async move { freeze_volume(&app).await })
        }
        HostToGuest::ThawVolume { .. } => {
            spawn_op(app, tx, id, |app| async move { thaw_volume(&app).await })
        }
        HostToGuest::GpuAttached { pci_address, .. } => {
            spawn_op(app, tx, id, move |app| async move {
                gpu_attached(&app, pci_address).await
            })
        }
        HostToGuest::GpuDetach { .. } => {
            spawn_op(app, tx, id, |app| async move { gpu_detach(&app).await })
        }
        HostToGuest::Unknown => {}
    }
}

fn dispatch_box(app: &Arc<App>, link: &BoxLink, line: &[u8]) {
    let frame: BoxToGuest = match serde_json::from_slice(line) {
        Ok(frame) => frame,
        Err(e) => {
            log(format!("ignoring malformed box frame: {e}"));
            return;
        }
    };
    match frame {
        BoxToGuest::Hello { box_version } => log(format!("box connected (version {box_version})")),
        BoxToGuest::Activity { activity } => *link.activity.lock().unwrap() = Some(activity),
        BoxToGuest::GpuWanted { wanted } => send_to_host(app, GuestToHost::GpuWanted { wanted }),
        BoxToGuest::Reply(body) => {
            let waiter = link.pending.lock().unwrap().remove(&body.id);
            match waiter {
                Some(waiter) => {
                    let _ = waiter.send(body);
                }
                None => log(format!("box reply for an unknown request {}", body.id)),
            }
        }
        BoxToGuest::Unknown => {}
    }
}

fn status_frame(app: &App) -> Option<GuestToHost> {
    let pressure = match read_pressure() {
        Ok(pressure) => pressure,
        Err(e) => {
            log(format!("status skipped: {e}"));
            return None;
        }
    };
    let (gpu, box_link) = {
        let st = app.lock();
        (st.gpu, st.box_link.clone())
    };
    let activity = box_link.and_then(|link| *link.activity.lock().unwrap());
    Some(GuestToHost::Status {
        pressure,
        activity,
        gpu,
    })
}

async fn send_host(tx: &mpsc::Sender<Outgoing<GuestToHost>>, body: ReplyBody) {
    if tx
        .send(Outgoing::new(GuestToHost::Reply(body)))
        .await
        .is_err()
    {
        log("host link closed before its reply was sent");
    }
}

fn send_to_host(app: &App, frame: GuestToHost) {
    let host = app.lock().host.clone();
    match host {
        Some(host) => {
            if let Err(e) = host.tx.try_send(Outgoing::new(frame)) {
                log(format!("host link unavailable: {e}"));
            }
        }
        None => log("no host connected; frame dropped"),
    }
}

/// Runs `op` under `op_lock` and replies with its result.
fn spawn_op<F, Fut>(app: &Arc<App>, tx: &mpsc::Sender<Outgoing<GuestToHost>>, id: String, op: F)
where
    F: FnOnce(Arc<App>) -> Fut + Send + 'static,
    Fut: Future<Output = Res<()>> + Send + 'static,
{
    let app = app.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = {
            let _guard = app.op_lock.lock().await;
            op(app.clone()).await
        };
        send_host(&tx, reply(id, result)).await;
    });
}

/// Acknowledges the shutdown, waits until the acknowledgement left the socket, then powers off.
fn spawn_shutdown(app: Arc<App>, tx: mpsc::Sender<Outgoing<GuestToHost>>, id: String) {
    tokio::spawn(async move {
        let _guard = app.op_lock.lock().await;
        let (flushed_tx, flushed_rx) = oneshot::channel();
        let ack = Outgoing {
            frame: GuestToHost::Reply(reply(id, Ok(()))),
            flushed: Some(flushed_tx),
        };
        if tx.send(ack).await.is_err() {
            log("host link closed; powering off without an acknowledgement");
        } else if timeout(SHUTDOWN_FLUSH_WAIT, flushed_rx).await.is_err() {
            log("shutdown acknowledgement not flushed in time; powering off");
        }
        if let Err(e) = app.sys.run("systemctl", &["poweroff"]).await {
            log(format!("poweroff failed: {e}"));
        }
    });
}

/// One request to the box. `Ok(false)` when no box is connected: there is nothing to tell.
async fn ask_box(
    app: &Arc<App>,
    wait: Duration,
    request: impl FnOnce(String) -> GuestToBox,
) -> Res<bool> {
    let link = app.lock().box_link.clone();
    let Some(link) = link else {
        return Ok(false);
    };
    let id = link.next_request_id();
    let (reply_tx, reply_rx) = oneshot::channel();
    link.pending.lock().unwrap().insert(id.clone(), reply_tx);
    if link
        .tx
        .send(Outgoing::new(request(id.clone())))
        .await
        .is_err()
    {
        link.pending.lock().unwrap().remove(&id);
        return Err("box link closed".into());
    }
    match timeout(wait, reply_rx).await {
        Ok(Ok(body)) if body.ok => Ok(true),
        Ok(Ok(body)) => Err(body
            .error
            .unwrap_or_else(|| "box refused the request".into())),
        Ok(Err(_)) => Err("box link closed before it replied".into()),
        Err(_) => {
            link.pending.lock().unwrap().remove(&id);
            Err(format!("box did not reply within {}s", wait.as_secs()))
        }
    }
}

fn mount_arg(app: &App) -> Res<&str> {
    app.cfg
        .volume_mount
        .to_str()
        .ok_or_else(|| "volume mount path is not UTF-8".to_string())
}

async fn configure_op(app: &Arc<App>, args: ConfigureArgs) -> Res<()> {
    configure::configure(&app.cfg, &app.sys, &args).await?;
    let mut st = app.lock();
    st.configured = true;
    st.clone_id = Some(args.clone_id);
    Ok(())
}

async fn prepare_suspend(app: &Arc<App>) -> Res<()> {
    ask_box(app, QUIESCE_WAIT, |id| GuestToBox::Quiesce { id }).await?;
    sync_all();
    app.sys.write_knob("/proc/sys/vm/drop_caches", "3")
}

async fn resumed(app: &Arc<App>, wall_clock_ms: u64) -> Res<()> {
    app.sys.set_realtime(wall_clock_ms)?;
    if let Err(e) = app.sys.run("chronyc", &["makestep"]).await {
        log(format!("chronyc makestep (ignored): {e}"));
    }
    ask_box(app, RESUME_WAIT, |id| GuestToBox::Resumed { id }).await?;
    wait_healthy(&app.cfg.box_health_url, RESUME_HEALTH_WAIT).await
}

async fn freeze_volume(app: &Arc<App>) -> Res<()> {
    if app.lock().frozen.is_some() {
        return Err("the volume is already frozen".into());
    }
    ask_box(app, FREEZE_QUIESCE_WAIT, |id| GuestToBox::Quiesce { id }).await?;
    sync_all();
    app.sys
        .run("fsfreeze", &["--freeze", mount_arg(app)?])
        .await?;
    let seq = {
        let mut st = app.lock();
        st.freeze_seq += 1;
        st.frozen = Some(st.freeze_seq);
        st.freeze_seq
    };
    tokio::spawn(auto_thaw(app.clone(), seq));
    Ok(())
}

/// A freeze the host never thawed is released after `FREEZE_TIMEOUT`, so a lost host cannot leave the box stuck.
async fn auto_thaw(app: Arc<App>, seq: u64) {
    sleep(FREEZE_TIMEOUT).await;
    let _guard = app.op_lock.lock().await;
    if app.lock().frozen != Some(seq) {
        return;
    }
    log("volume still frozen after its timeout; thawing");
    if let Err(e) = thaw_now(&app).await {
        log(format!("automatic thaw failed: {e}"));
    }
}

async fn thaw_volume(app: &Arc<App>) -> Res<()> {
    if app.lock().frozen.is_none() {
        return Ok(());
    }
    thaw_now(app).await
}

async fn thaw_now(app: &Arc<App>) -> Res<()> {
    app.sys
        .run("fsfreeze", &["--unfreeze", mount_arg(app)?])
        .await?;
    app.lock().frozen = None;
    Ok(())
}

fn set_gpu(app: &App, state: GpuState, pci_address: Option<String>) {
    {
        let mut st = app.lock();
        st.gpu = state;
        st.gpu_pci = pci_address.clone();
    }
    let box_link = app.lock().box_link.clone();
    if let Some(link) = box_link {
        if let Err(e) = link
            .tx
            .try_send(Outgoing::new(GuestToBox::GpuState { state, pci_address }))
        {
            log(format!("box did not get the GPU state: {e}"));
        }
    }
}

async fn gpu_attached(app: &Arc<App>, pci_address: String) -> Res<()> {
    set_gpu(app, GpuState::Attaching, Some(pci_address.clone()));
    match gpu::attach(&app.sys, &pci_address).await {
        Ok(()) => {
            set_gpu(app, GpuState::Attached, Some(pci_address));
            Ok(())
        }
        Err(e) => {
            set_gpu(app, GpuState::None, None);
            Err(e)
        }
    }
}

async fn gpu_detach(app: &Arc<App>) -> Res<()> {
    let (state, pci_address) = app.gpu_snapshot();
    if state == GpuState::None {
        return Ok(());
    }
    set_gpu(app, GpuState::Detaching, pci_address.clone());
    if let Err(e) = ask_box(app, RELEASE_WAIT, |id| GuestToBox::ReleaseGpu { id }).await {
        set_gpu(app, GpuState::Attached, pci_address);
        return Err(format!("box did not release the GPU: {e}"));
    }
    match gpu::detach(&app.sys).await {
        Ok(()) => {
            set_gpu(app, GpuState::None, None);
            Ok(())
        }
        Err(e) => {
            set_gpu(app, GpuState::Attached, pci_address);
            Err(e)
        }
    }
}
