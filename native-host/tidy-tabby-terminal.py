#!/usr/bin/env python3
"""
Tidy Tabby Terminal — Chrome Native Messaging Host

Spawns a PTY shell and relays I/O using Chrome's native messaging
protocol. Chrome auto-launches this script — no manual startup needed.
"""

import json
import os
import pty
import select
import signal
import shutil
import struct
import sys
import threading

# Default to Claude Code if installed, fallback to shell
CLAUDE_PATH = shutil.which("claude")
DEFAULT_CMD = CLAUDE_PATH if CLAUDE_PATH else os.environ.get("SHELL", "/bin/zsh")
CMD = os.environ.get("TIDY_TABBY_CMD", DEFAULT_CMD)
CMD_ARGS = [CMD] if CMD == CLAUDE_PATH else [CMD, "-l"]


def read_message():
    """Read one native message from stdin."""
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    if length == 0:
        return None
    data = sys.stdin.buffer.read(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(msg):
    """Send one native message to stdout."""
    encoded = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    # Spawn PTY using pty.spawn approach with openpty
    master_fd, slave_fd = pty.openpty()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"

    pid = os.fork()
    if pid == 0:
        # Child process — become the shell
        os.close(master_fd)
        os.setsid()

        import fcntl
        import termios
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.execvpe(CMD, CMD_ARGS, env)
        sys.exit(1)

    # Parent process — relay between Chrome and PTY
    os.close(slave_fd)

    running = True

    def pty_reader():
        """Read from PTY master and send to Chrome."""
        while running:
            try:
                rlist, _, _ = select.select([master_fd], [], [], 0.05)
                if rlist:
                    try:
                        data = os.read(master_fd, 16384)
                    except OSError:
                        break
                    if not data:
                        break
                    send_message({"type": "output", "data": data.decode("utf-8", errors="replace")})
            except (ValueError, OSError):
                break

        try:
            send_message({"type": "disconnected", "data": "Shell exited"})
        except (BrokenPipeError, OSError):
            pass

    reader_thread = threading.Thread(target=pty_reader, daemon=True)
    reader_thread.start()

    # Main thread: read from Chrome, write to PTY
    try:
        while True:
            msg = read_message()
            if msg is None:
                break

            if msg.get("type") == "input":
                data = msg.get("data", "")
                try:
                    os.write(master_fd, data.encode("utf-8"))
                except OSError:
                    break

            elif msg.get("type") == "resize":
                import fcntl
                import termios
                cols = msg.get("cols", 80)
                rows = msg.get("rows", 24)
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                try:
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except OSError:
                    pass

    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        running = False
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass


if __name__ == "__main__":
    main()
