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
use tokio::time::{interval, timeout, MissedTickBehavior};

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
/// Longest the volume sync may take in a freeze or suspend. The host's op timeouts also cover the quiesce wait.
const SYNC_WAIT: Duration = Duration::from_secs(10);

pub struct App {
    pub cfg: Config,
    pub sys: System,
    boot_id: String,
    op_lock: AsyncMutex<()>,
    /// Serializes thaws and freezes, so a host `thawVolume` never races a freeze in progress.
    thaw_lock: AsyncMutex<()>,
    state: Mutex<State>,
}

struct State {
    next_link: u64,
    configured: bool,
    clone_id: Option<String>,
    gpu: GpuState,
    gpu_pci: Option<String>,
    frozen: bool,
    /// Bumped by every `thawVolume`, under `thaw_lock`. A freeze queued before a thaw is refused: the host gave up on it.
    thaw_epoch: u64,
    host: Option<HostLink>,
    host_task: Option<AbortHandle>,
    box_link: Option<Arc<BoxLink>>,
    /// The box request (`gpuWanted`) the host has not answered yet; one at a time.
    box_gpu_request: Option<String>,
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
            thaw_lock: AsyncMutex::new(()),
            state: Mutex::new(State {
                next_link: 0,
                configured,
                clone_id,
                gpu: GpuState::None,
                gpu_pci: None,
                frozen: false,
                thaw_epoch: 0,
                host: None,
                host_task: None,
                box_link: None,
                box_gpu_request: None,
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
            st.box_gpu_request = None;
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
        HostToGuest::GpuDecision { granted, error, .. } => gpu_decision(app, id, granted, error),
        HostToGuest::Configure(args) => spawn_op(app, tx, id, move |app| async move {
            configure_op(&app, *args).await
        }),
        HostToGuest::PrepareSuspend { .. } => {
            let epoch = app.lock().thaw_epoch;
            spawn_op(app, tx, id, move |app| async move {
                prepare_suspend(&app, epoch).await
            })
        }
        HostToGuest::Resumed { wall_clock_ms, .. } => {
            spawn_op(app, tx, id, move |app| async move {
                resumed(&app, wall_clock_ms).await
            })
        }
        HostToGuest::FreezeVolume { .. } => {
            let epoch = app.lock().thaw_epoch;
            spawn_op(app, tx, id, move |app| async move {
                freeze_volume(&app, epoch).await
            })
        }
        HostToGuest::ThawVolume { .. } => spawn_thaw(app, tx, id),
        HostToGuest::GpuAttached { pci_address, .. } => {
            spawn_op(app, tx, id, move |app| async move {
                let result = gpu_attached(&app, pci_address).await;
                answer_pending_gpu(&app, &result);
                result
            })
        }
        HostToGuest::GpuDetach { .. } => spawn_op(app, tx, id, |app| async move {
            let result = gpu_detach(&app).await;
            answer_pending_gpu(&app, &result);
            result
        }),
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
        BoxToGuest::GpuWanted { id, wanted } => request_gpu(app, id, wanted),
        BoxToGuest::Enrolled => forget_enroll_token(app),
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

/// Sends `frame` to the connected host. `false` when no host is connected or its link refused the frame.
fn send_to_host(app: &App, frame: GuestToHost) -> bool {
    let host = app.lock().host.clone();
    let Some(host) = host else {
        log("no host connected; frame dropped");
        return false;
    };
    match host.tx.try_send(Outgoing::new(frame)) {
        Ok(()) => true,
        Err(e) => {
            log(format!("host link unavailable: {e}"));
            false
        }
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

/// Thaws without `op_lock`: a thaw must get through while another op is blocked on the frozen volume.
fn spawn_thaw(app: &Arc<App>, tx: &mpsc::Sender<Outgoing<GuestToHost>>, id: String) {
    let app = app.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = thaw_volume(&app).await;
        send_host(&tx, reply(id, result)).await;
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
    if app.lock().frozen {
        return Err("volume frozen; thaw it before configure".into());
    }
    configure::configure(&app.cfg, &app.sys, &args).await?;
    let mut st = app.lock();
    st.configured = true;
    st.clone_id = Some(args.clone_id);
    Ok(())
}

/// Syncs the volume for at most `SYNC_WAIT`, so a freeze or suspend finishes inside the host's op timeout.
async fn sync_volume() -> Res<()> {
    match timeout(SYNC_WAIT, sync_all()).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "volume sync did not finish within {}s",
            SYNC_WAIT.as_secs()
        )),
    }
}

async fn prepare_suspend(app: &Arc<App>, epoch: u64) -> Res<()> {
    // Held through the freeze, as in `freeze_volume`: a host thaw that arrives meanwhile waits, then thaws what this froze.
    let _thaw = app.thaw_lock.lock().await;
    ensure_current(app, epoch)?;
    if app.lock().frozen {
        return Err("volume frozen; thaw it before suspend".into());
    }
    ask_box(app, QUIESCE_WAIT, |id| GuestToBox::Quiesce { id }).await?;
    sync_volume().await?;
    app.sys.write_knob("/proc/sys/vm/drop_caches", "3")?;
    freeze_now(app).await
}

async fn resumed(app: &Arc<App>, wall_clock_ms: u64) -> Res<()> {
    // A suspend or park leaves the volume frozen in the saved image, so the restored VM thaws it before the box writes.
    thaw_volume(app).await?;
    app.sys.set_realtime(wall_clock_ms)?;
    if let Err(e) = app.sys.run("chronyc", &["makestep"]).await {
        log(format!("chronyc makestep (ignored): {e}"));
    }
    ask_box(app, RESUME_WAIT, |id| GuestToBox::Resumed { id }).await?;
    wait_healthy(&app.cfg.box_health_url, RESUME_HEALTH_WAIT).await
}

async fn freeze_volume(app: &Arc<App>, epoch: u64) -> Res<()> {
    // Held until the freeze completes or fails: a thaw that arrives meanwhile waits here, then really thaws, instead of
    // finding nothing frozen and returning early.
    let _thaw = app.thaw_lock.lock().await;
    ensure_current(app, epoch)?;
    if app.lock().frozen {
        return Err("the volume is already frozen".into());
    }
    ask_box(app, FREEZE_QUIESCE_WAIT, |id| GuestToBox::Quiesce { id }).await?;
    sync_volume().await?;
    freeze_now(app).await
}

/// Freezes the volume. It stays frozen until `thawVolume`, or `resumed` after a suspend: the guest never thaws it on its
/// own, because the host owns every freeze and ends it (or stops the VM).
async fn freeze_now(app: &Arc<App>) -> Res<()> {
    app.sys
        .run("fsfreeze", &["--freeze", mount_arg(app)?])
        .await?;
    app.lock().frozen = true;
    Ok(())
}

/// Thaws the volume if it is frozen. Takes `thaw_lock` only, so it runs while an op holds `op_lock`. Every thaw bumps
/// `thaw_epoch`, cancelling freezes queued before it.
async fn thaw_volume(app: &Arc<App>) -> Res<()> {
    let _guard = app.thaw_lock.lock().await;
    app.lock().thaw_epoch += 1;
    if !app.lock().frozen {
        return Ok(());
    }
    app.sys
        .run("fsfreeze", &["--unfreeze", mount_arg(app)?])
        .await?;
    app.lock().frozen = false;
    Ok(())
}

/// Refuses a freeze requested before a `thawVolume` that has since run. The host sent that thaw because it gave up on the
/// freeze, so the freeze must not take effect now.
fn ensure_current(app: &App, epoch: u64) -> Res<()> {
    if app.lock().thaw_epoch != epoch {
        return Err("thawed while queued; freeze cancelled".into());
    }
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
            // Modules loaded before the failure stay loaded unless unloaded now. If that fails, the GPU stays recorded
            // as attached, so the host's gpuDetach retries the unload instead of finding nothing to do.
            match gpu::detach(&app.sys).await {
                Ok(()) => set_gpu(app, GpuState::None, None),
                Err(unload) => {
                    log(format!(
                        "could not unload the partly attached GPU: {unload}"
                    ));
                    set_gpu(app, GpuState::Attached, Some(pci_address));
                }
            }
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

/// Forwards the box's GPU request to the host, which answers with `gpuDecision`. One request is open at a time: a second
/// one is refused at once.
fn request_gpu(app: &Arc<App>, id: String, wanted: bool) {
    let busy = {
        let mut st = app.lock();
        let busy = st.box_gpu_request.is_some();
        if !busy {
            st.box_gpu_request = Some(id.clone());
        }
        busy
    };
    if busy {
        answer_box(
            app,
            id,
            Err("another GPU request is still in progress".into()),
        );
        return;
    }
    if !send_to_host(
        app,
        GuestToHost::GpuWanted {
            id: id.clone(),
            wanted,
        },
    ) {
        app.lock().box_gpu_request = None;
        answer_box(app, id, Err("the host is not connected".into()));
    }
}

/// The host's answer to the box's GPU request `id`. A denial answers the box at once. A grant waits for the attach or
/// detach the host sends next, which answers the box.
fn gpu_decision(app: &Arc<App>, id: String, granted: bool, error: Option<String>) {
    let open = app.lock().box_gpu_request.as_deref() == Some(id.as_str());
    if !open {
        log(format!("gpu decision for an unknown request {id}"));
        return;
    }
    if granted {
        return;
    }
    app.lock().box_gpu_request = None;
    answer_box(
        app,
        id,
        Err(error.unwrap_or_else(|| "the host denied the GPU".into())),
    );
}

/// Answers the open GPU request, if any, with the result of the attach or detach that completes it.
fn answer_pending_gpu(app: &Arc<App>, result: &Res<()>) {
    let pending = app.lock().box_gpu_request.take();
    if let Some(id) = pending {
        answer_box(app, id, result.clone());
    }
}

/// Replies to the box's request `id` on the box link. With no box connected nothing waits for the answer.
fn answer_box(app: &App, id: String, result: Res<()>) {
    let link = app.lock().box_link.clone();
    let Some(link) = link else {
        log("no box connected; GPU answer dropped");
        return;
    };
    if link
        .tx
        .try_send(Outgoing::new(GuestToBox::Reply(reply(id, result))))
        .is_err()
    {
        log("box link unavailable; GPU answer dropped");
    }
}

/// The box enrolled and kept its secret: the enroll token leaves the env file on the volume. Queued behind any op.
fn forget_enroll_token(app: &Arc<App>) {
    let app = app.clone();
    tokio::spawn(async move {
        let _guard = app.op_lock.lock().await;
        if let Err(e) = configure::drop_enroll_token(&app.cfg) {
            log(format!(
                "could not remove the enroll token from the box env: {e}"
            ));
        }
    });
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::PathBuf;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    use super::*;
    use crate::args::{parse, Parsed};
    use crate::protocol::{ConfigureArgs, GuestNetwork};

    /// An app whose volume is a fresh directory under the system temp dir, with no system side effects.
    fn app_on_volume(name: &str) -> (Arc<App>, PathBuf) {
        app_with_args(name, &[])
    }

    /// `app_on_volume`, started with extra command-line arguments.
    fn app_with_args(name: &str, extra: &[&str]) -> (Arc<App>, PathBuf) {
        let volume =
            env::temp_dir().join(format!("kestrel-guest-app-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&volume);
        std::fs::create_dir_all(&volume).expect("create volume dir");
        let mut args = vec![
            "--dry-run-system".to_string(),
            "--volume-mount".to_string(),
            volume.to_str().expect("utf-8 path").to_string(),
        ];
        args.extend(extra.iter().map(|arg| arg.to_string()));
        let cfg = match parse(args).expect("valid args") {
            Parsed::Run(cfg) => *cfg,
            Parsed::Help => panic!("parse returned help"),
        };
        let app = App::new(cfg, System { dry_run: true }).expect("create app");
        (app, volume)
    }

    /// A suspend freezes the volume and leaves it frozen: only `thawVolume` or `resumed` thaws it.
    #[tokio::test]
    async fn prepare_suspend_leaves_the_volume_frozen_until_a_thaw() {
        let (app, _volume) = app_on_volume("suspend-freezes");
        let epoch = app.lock().thaw_epoch;
        prepare_suspend(&app, epoch)
            .await
            .expect("suspend prepares");
        assert!(app.lock().frozen);
        thaw_volume(&app).await.expect("thaw succeeds");
        assert!(!app.lock().frozen);
    }

    /// `resumed` thaws the volume a suspend froze, before the box is told it resumed.
    #[tokio::test]
    async fn resumed_thaws_a_suspended_volume() {
        let health = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind health listener");
        let port = health.local_addr().expect("health address").port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = health.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 1024];
                    let _ = stream.read(&mut request).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                });
            }
        });
        let health_url = format!("http://127.0.0.1:{port}/api/health");
        let (app, _volume) =
            app_with_args("resume-thaws", &["--box-health-url", health_url.as_str()]);
        app.lock().frozen = true;
        timeout(Duration::from_secs(5), resumed(&app, 0))
            .await
            .expect("resume finished")
            .expect("resume succeeds");
        assert!(!app.lock().frozen);
    }

    /// A host thaw gets through while an op holds `op_lock`, so the host's thaw reply is never stuck behind it.
    #[tokio::test]
    async fn host_thaw_does_not_wait_for_a_blocked_op() {
        let (app, _volume) = app_on_volume("host-thaw");
        app.lock().frozen = true;
        let _blocked_op = app.op_lock.lock().await;

        timeout(Duration::from_secs(5), thaw_volume(&app))
            .await
            .expect("thaw ran while an op held op_lock")
            .expect("thaw succeeds");
        assert!(!app.lock().frozen);
    }

    /// A thaw that arrives while a freeze is in progress waits for the freeze, then thaws what it froze. It must not
    /// return early with the volume still frozen.
    #[tokio::test]
    async fn thaw_during_a_freeze_thaws_it() {
        let (app, _volume) = app_on_volume("thaw-during-freeze");
        // A freeze holds thaw_lock from its start until it completes.
        let freezing = app.thaw_lock.lock().await;
        let thaw = tokio::spawn({
            let app = app.clone();
            async move { thaw_volume(&app).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !thaw.is_finished(),
            "thaw returned while the freeze held thaw_lock"
        );
        app.lock().frozen = true;
        drop(freezing);
        timeout(Duration::from_secs(5), thaw)
            .await
            .expect("thaw finished after the freeze")
            .expect("thaw task joined")
            .expect("thaw succeeds");
        assert!(!app.lock().frozen);
    }

    /// Suspend syncs and drops caches under the volume, so a frozen volume refuses it before it asks the box to quiesce.
    #[tokio::test]
    async fn prepare_suspend_refuses_a_frozen_volume() {
        let (app, _volume) = app_on_volume("suspend-frozen");
        app.lock().frozen = true;
        let epoch = app.lock().thaw_epoch;
        let err = prepare_suspend(&app, epoch)
            .await
            .expect_err("frozen volume refuses suspend");
        assert!(err.contains("volume frozen"), "unexpected error: {err}");
        assert!(app.lock().frozen);
    }

    /// The host sends `thawVolume` after it gives up on a freeze, and a thaw skips `op_lock`, so the thaw can run while the
    /// freeze still waits behind another op. That freeze must be refused when it finally runs, or the volume stays frozen
    /// with no timer left to release it.
    #[tokio::test]
    async fn a_freeze_queued_before_a_thaw_is_cancelled() {
        let (app, _volume) = app_on_volume("queued-freeze");
        let queued = app.lock().thaw_epoch;
        thaw_volume(&app)
            .await
            .expect("thaw succeeds with nothing frozen");
        let err = freeze_volume(&app, queued)
            .await
            .expect_err("freeze queued before the thaw is refused");
        assert!(
            err.contains("thawed while queued"),
            "unexpected error: {err}"
        );
        assert!(!app.lock().frozen);
    }

    /// Configure writes the volume, so a frozen volume refuses it before anything is written.
    #[tokio::test]
    async fn configure_refuses_a_frozen_volume() {
        let (app, volume) = app_on_volume("configure-frozen");
        app.lock().frozen = true;
        let args = ConfigureArgs {
            id: "req-1".into(),
            host_id: "host-1".into(),
            box_id: "box-1".into(),
            vm_id: "vm-1".into(),
            clone_id: "0123456789abcdef0123456789abcdef".into(),
            wall_clock_ms: 0,
            control_url: "https://control.example".into(),
            public_url: "https://box.example".into(),
            enroll_token: None,
            network: GuestNetwork {
                address: "10.77.0.5/32".into(),
                gateway: "10.77.0.1".into(),
                ipv6_address: None,
                ipv6_gateway: None,
                dns: vec![],
                depcache_url: None,
                nix_cache_url: None,
                nix_cache_public_key: None,
            },
        };

        let err = configure_op(&app, args)
            .await
            .expect_err("frozen volume refuses configure");
        assert!(err.contains("volume frozen"), "unexpected error: {err}");
        assert!(!volume.join("home").exists());
        assert!(!volume.join("box.env").exists());
        assert!(app.lock().frozen);
    }
}
