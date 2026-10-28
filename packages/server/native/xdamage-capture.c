/*
 * xdamage-capture: runs COMMAND with the X root window on its stdin as raw frames, but only when
 * something on screen changed. The remote desktop uses it to feed ffmpeg (`-f rawvideo -pix_fmt bgr0`).
 *
 * usage: xdamage-capture WIDTH HEIGHT COMMAND [ARGS...]   (display from $DISPLAY)
 *
 * Each frame is WIDTH*HEIGHT*4 bytes, 32-bit pixels laid out B G R 0. A frame is emitted when:
 *   - the screen has damage (XDamage), or
 *   - the cursor image changed (XFixes), or
 *   - the pointer moved (polled; the pointer produces no damage of its own).
 * Frames are rate-limited to 60 per second. The cursor is composited into the frame because the
 * X server hides the software cursor from GetImage. COMMAND's stdout and stderr are inherited, so the
 * process group carries COMMAND's output. When COMMAND exits, so does this helper, with its status.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>

#define FRAME_NS 16666667LL

static int frame_fd = -1;
static pid_t child = -1;

static void die(const char *msg) {
	fprintf(stderr, "xdamage-capture: %s\n", msg);
	exit(1);
}

static void die_errno(const char *msg) {
	fprintf(stderr, "xdamage-capture: %s: %s\n", msg, strerror(errno));
	exit(1);
}

/* COMMAND has closed its stdin: wait for it and exit with its status. */
static void reap_and_exit(void) {
	int status = 0;
	while (waitpid(child, &status, 0) < 0 && errno == EINTR) {
	}
	if (WIFEXITED(status)) exit(WEXITSTATUS(status));
	if (WIFSIGNALED(status)) exit(128 + WTERMSIG(status));
	exit(1);
}

static int64_t now_ns(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void write_all(const uint8_t *buf, size_t n) {
	while (n > 0) {
		ssize_t w = write(frame_fd, buf, n);
		if (w < 0) {
			if (errno == EINTR) continue;
			if (errno == EPIPE) reap_and_exit();
			die_errno("write");
		}
		buf += w;
		n -= (size_t)w;
	}
}

/* Premultiplied ARGB cursor image over bgr0 pixels: dst = src + dst * (1 - alpha). */
static void composite_cursor(uint8_t *dst, int width, int height, const XFixesCursorImage *c, int px, int py) {
	int x0 = px - (int)c->xhot;
	int y0 = py - (int)c->yhot;
	for (int row = 0; row < (int)c->height; row++) {
		int y = y0 + row;
		if (y < 0 || y >= height) continue;
		for (int col = 0; col < (int)c->width; col++) {
			int x = x0 + col;
			if (x < 0 || x >= width) continue;
			uint32_t s = (uint32_t)c->pixels[(size_t)row * c->width + col];
			uint32_t a = s >> 24;
			if (a == 0) continue;
			uint8_t *d = dst + ((size_t)y * width + x) * 4;
			uint32_t inv = 255 - a;
			d[0] = (uint8_t)((s & 0xff) + (d[0] * inv + 127) / 255);
			d[1] = (uint8_t)(((s >> 8) & 0xff) + (d[1] * inv + 127) / 255);
			d[2] = (uint8_t)(((s >> 16) & 0xff) + (d[2] * inv + 127) / 255);
		}
	}
}

int main(int argc, char **argv) {
	if (argc < 4) die("usage: xdamage-capture WIDTH HEIGHT COMMAND [ARGS...]");
	int width = atoi(argv[1]);
	int height = atoi(argv[2]);
	if (width <= 0 || height <= 0) die("invalid size");

	/* Start COMMAND first so the X connection is not inherited by it. */
	int fds[2];
	if (pipe(fds) < 0) die_errno("pipe");
	child = fork();
	if (child < 0) die_errno("fork");
	if (child == 0) {
		close(fds[1]);
		if (dup2(fds[0], STDIN_FILENO) < 0) _exit(127);
		close(fds[0]);
		signal(SIGPIPE, SIG_DFL);
		execvp(argv[3], &argv[3]);
		fprintf(stderr, "xdamage-capture: cannot run %s: %s\n", argv[3], strerror(errno));
		_exit(127);
	}
	close(fds[0]);
	frame_fd = fds[1];
	signal(SIGPIPE, SIG_IGN);

	Display *dpy = XOpenDisplay(NULL);
	if (!dpy) die("cannot open display");
	int scr = DefaultScreen(dpy);
	Window root = RootWindow(dpy, scr);
	Visual *vis = DefaultVisual(dpy, scr);

	if (DisplayWidth(dpy, scr) != width || DisplayHeight(dpy, scr) != height) die("display size does not match WIDTH HEIGHT");
	if (DefaultDepth(dpy, scr) != 24) die("root window depth must be 24");
	if (vis->red_mask != 0xff0000 || vis->green_mask != 0xff00 || vis->blue_mask != 0xff) die("unsupported visual layout");
	if (ImageByteOrder(dpy) != LSBFirst) die("big-endian X servers are not supported");

	int shm_major, shm_minor;
	Bool shm_pixmaps;
	if (!XShmQueryVersion(dpy, &shm_major, &shm_minor, &shm_pixmaps)) die("MIT-SHM extension missing");
	int damage_event, damage_error;
	if (!XDamageQueryExtension(dpy, &damage_event, &damage_error)) die("DAMAGE extension missing");
	int fixes_event, fixes_error;
	if (!XFixesQueryExtension(dpy, &fixes_event, &fixes_error)) die("XFIXES extension missing");

	XShmSegmentInfo shm;
	XImage *img = XShmCreateImage(dpy, vis, 24, ZPixmap, NULL, &shm, width, height);
	if (!img) die("XShmCreateImage failed");
	if (img->bits_per_pixel != 32 || img->bytes_per_line != width * 4) die("unexpected image layout");
	size_t frame_bytes = (size_t)img->bytes_per_line * img->height;
	shm.shmid = shmget(IPC_PRIVATE, frame_bytes, IPC_CREAT | 0600);
	if (shm.shmid < 0) die_errno("shmget");
	shm.shmaddr = img->data = shmat(shm.shmid, NULL, 0);
	if (shm.shmaddr == (char *)-1) die_errno("shmat");
	shm.readOnly = False;
	if (!XShmAttach(dpy, &shm)) die("XShmAttach failed");
	XSync(dpy, False);
	shmctl(shm.shmid, IPC_RMID, NULL);

	Damage damage = XDamageCreate(dpy, root, XDamageReportNonEmpty);
	XFixesSelectCursorInput(dpy, root, XFixesDisplayCursorNotifyMask);
	XFixesCursorImage *cursor = XFixesGetCursorImage(dpy);

	int xfd = ConnectionNumber(dpy);
	int64_t next_slot = 0; /* earliest time the next frame may be sent */
	int pending = 1; /* emit the first frame immediately */
	int have_pointer = 0;
	int px = 0, py = 0;

	for (;;) {
		while (XPending(dpy) > 0) {
			XEvent ev;
			XNextEvent(dpy, &ev);
			if (ev.type == damage_event + XDamageNotify) {
				pending = 1;
			} else if (ev.type == fixes_event + XFixesCursorNotify) {
				XFree(cursor);
				cursor = XFixesGetCursorImage(dpy);
				pending = 1;
			}
		}

		Window w_root, w_child;
		int rx, ry, wx, wy;
		unsigned int mask;
		if (XQueryPointer(dpy, root, &w_root, &w_child, &rx, &ry, &wx, &wy, &mask)) {
			if (!have_pointer || rx != px || ry != py) pending = 1;
			have_pointer = 1;
			px = rx;
			py = ry;
		}

		int64_t now = now_ns();
		if (pending && now >= next_slot) {
			/* Clear damage before grabbing so changes that land during the grab trigger the next frame. */
			XDamageSubtract(dpy, damage, None, None);
			if (!XShmGetImage(dpy, root, img, 0, 0, AllPlanes)) die("XShmGetImage failed");
			if (cursor && have_pointer) composite_cursor((uint8_t *)img->data, width, height, cursor, px, py);
			write_all((const uint8_t *)img->data, frame_bytes);
			/* Fixed 60 Hz grid: wake-up latency must not accumulate into drift against the damage source. Restart the grid after a stall. */
			next_slot += FRAME_NS;
			if (now >= next_slot) next_slot = now + FRAME_NS;
			pending = 0;
		}

		/* Wake for the next frame slot while pending, otherwise poll the pointer at 60 Hz. */
		int64_t wait_ns = pending ? next_slot - now : FRAME_NS;
		if (wait_ns < 0) wait_ns = 0;
		struct timespec timeout = { .tv_sec = wait_ns / 1000000000LL, .tv_nsec = wait_ns % 1000000000LL };
		struct pollfd fds_poll[2] = {
			{ .fd = xfd, .events = POLLIN },
			{ .fd = frame_fd, .events = 0 },
		};
		if (ppoll(fds_poll, 2, &timeout, NULL) < 0 && errno != EINTR) die_errno("ppoll");
		if (fds_poll[1].revents & (POLLERR | POLLHUP)) reap_and_exit();
	}
}
