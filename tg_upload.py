#!/usr/bin/env python3
"""
Telegram upload worker for diskclean (telegram.js drives it).

Logs in as the bot over MTProto (Telethon), which allows files up to 2 GB,
unlike the 50 MB cap of the HTTP Bot API.

Usage: tg_upload.py <config.json> <session path>
Protocol, one JSON object per line:
  stdout {"ready": true}                          logged in, chat resolved
  stdin  {"files": [paths], "caption": "..."}     send one album (1 to 10 files)
  stdout {"frac": 0.42}                           progress of the current album
  stdout {"wait": 30}                             Telegram rate limit, sleeping
  stdout {"ok": true, "sizes": [bytes stored per message]} | {"ok": false, "error": "..."}
"""

import asyncio
import json
import logging
import sys

from telethon import TelegramClient


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class FloodWaitReporter(logging.Handler):
    """Telethon sleeps through rate limits silently; surface them as progress."""

    def emit(self, record):
        # Telethon logs ('Sleeping%s for %ds ...', ' early' or '', seconds, ...).
        if "flood wait" in str(record.msg):
            secs = next((a for a in record.args or () if isinstance(a, int)), 0)
            out({"wait": secs})


async def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
    client = TelegramClient(sys.argv[2], int(cfg["api_id"]), cfg["api_hash"])
    # Wait out rate limits (up to an hour each) instead of failing the backup.
    client.flood_sleep_threshold = 3600
    logging.getLogger("telethon").addHandler(FloodWaitReporter())
    logging.getLogger("telethon").setLevel(logging.INFO)

    await client.start(bot_token=cfg["token"])
    chat = str(cfg["chat"])
    entity = await client.get_input_entity(int(chat) if chat.lstrip("-").isdigit() else chat)
    out({"ready": True})

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while line := await reader.readline():
        req = json.loads(line)
        files = req["files"]
        # For one file Telethon reports (bytes, total); for an album (files done, count).
        progress = lambda cur, total: out({"frac": cur / total if total else 0})
        try:
            if len(files) == 1:
                msgs = [await client.send_file(
                    entity, files[0], caption=req["caption"],
                    force_document=True, progress_callback=progress)]
            else:
                msgs = await client.send_file(
                    entity, files, caption=[req["caption"]] + [""] * (len(files) - 1),
                    force_document=True, progress_callback=progress)
            # Report what Telegram actually stored; Node compares it to the local files.
            out({"ok": True, "sizes": [m.file.size if m.file else -1 for m in msgs]})
        except Exception as e:  # report and let Node decide, never half-silently continue
            out({"ok": False, "error": f"{type(e).__name__}: {e}"})

    await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)
