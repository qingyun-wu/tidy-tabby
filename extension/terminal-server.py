#!/usr/bin/env python3
"""
Tidy Tabby Terminal Server

A simple WebSocket-to-PTY relay that lets the browser terminal
connect to a real shell. Run this script, then click "Connect"
in the Terminal tab.

Usage:
    python3 terminal-server.py [--port 8765] [--shell /bin/zsh]

Requires: pip install websockets
"""

import asyncio
import os
import pty
import signal
import struct
import sys
import fcntl
import termios

try:
    import websockets
except ImportError:
    print("Missing dependency. Install with:")
    print("  pip install websockets")
    sys.exit(1)

SHELL = os.environ.get("SHELL", "/bin/zsh")
PORT = 8765

# Parse args
for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--port" and i < len(sys.argv) - 1:
        PORT = int(sys.argv[i + 1])
    elif arg == "--shell" and i < len(sys.argv) - 1:
        SHELL = sys.argv[i + 1]


async def terminal_handler(websocket):
    """Handle one WebSocket connection: spawn a shell and relay I/O."""
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
        os.execvp(SHELL, [SHELL, "-l"])

    # Parent: relay between WebSocket and PTY
    os.close(slave_fd)

    # Set master_fd to non-blocking
    import select

    async def read_pty():
        """Read from PTY and send to WebSocket."""
        loop = asyncio.get_event_loop()
        try:
            while True:
                await loop.run_in_executor(
                    None, lambda: select.select([master_fd], [], [], 0.1)
                )
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    await websocket.send(data.decode("utf-8", errors="replace"))
                except OSError:
                    break
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            pass

    async def write_pty():
        """Read from WebSocket and write to PTY."""
        try:
            async for message in websocket:
                os.write(master_fd, message.encode("utf-8"))
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            pass

    read_task = asyncio.create_task(read_pty())
    write_task = asyncio.create_task(write_pty())

    try:
        await asyncio.gather(read_task, write_task)
    finally:
        read_task.cancel()
        write_task.cancel()
        os.close(master_fd)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass


async def main():
    print(f"Tidy Tabby Terminal Server")
    print(f"  Shell:  {SHELL}")
    print(f"  Port:   {PORT}")
    print(f"  URL:    ws://localhost:{PORT}")
    print(f"\nWaiting for connections...")

    async with websockets.serve(terminal_handler, "localhost", PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
