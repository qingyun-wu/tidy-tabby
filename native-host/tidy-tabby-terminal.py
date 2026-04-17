#!/usr/bin/env python3
"""
Tidy Tabby Terminal — Chrome Native Messaging Host

This script is launched automatically by Chrome when the Terminal tab
connects. It spawns a PTY shell and relays I/O using Chrome's native
messaging protocol (4-byte length-prefixed JSON over stdin/stdout).

No manual startup needed — Chrome manages the lifecycle.
"""

import asyncio
import json
import os
import pty
import select
import signal
import struct
import sys
import fcntl
import termios
import threading

SHELL = os.environ.get("SHELL", "/bin/zsh")


def read_native_message():
    """Read one message from Chrome (stdin): 4-byte length + JSON."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length == 0:
        return None
    data = sys.stdin.buffer.read(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_native_message(msg):
    """Send one message to Chrome (stdout): 4-byte length + JSON."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    # Spawn PTY shell
    master_fd, slave_fd = pty.openpty()

    pid = os.fork()
    if pid == 0:
        # Child: become the shell
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(slave_fd)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        os.execvpe(SHELL, [SHELL, "-l"], env)

    # Parent: relay between Chrome native messaging and PTY
    os.close(slave_fd)

    running = True

    def read_pty_thread():
        """Read PTY output and send to Chrome."""
        while running:
            try:
                r, _, _ = select.select([master_fd], [], [], 0.05)
                if r:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    send_native_message({
                        "type": "output",
                        "data": data.decode("utf-8", errors="replace")
                    })
            except OSError:
                break
        send_native_message({"type": "disconnected", "data": "Shell exited"})

    pty_thread = threading.Thread(target=read_pty_thread, daemon=True)
    pty_thread.start()

    # Main thread: read Chrome messages and write to PTY
    try:
        while True:
            msg = read_native_message()
            if msg is None:
                break
            if msg.get("type") == "input":
                data = msg.get("data", "")
                os.write(master_fd, data.encode("utf-8"))
            elif msg.get("type") == "resize":
                cols = msg.get("cols", 80)
                rows = msg.get("rows", 24)
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        running = False
        os.close(master_fd)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass


if __name__ == "__main__":
    main()
