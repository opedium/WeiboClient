#!/usr/bin/python
# coding:utf-8

import time
from weibo import WeiBoClient
from weibo.util import bid_to_mid, load_from_yaml

# ── config ────────────────────────────────────────────────
TARGET_MBLOGID  = 'QCv7TyBL0'   # last segment of the weibo URL to repost
ACCOUNT_GAP     = 15             # seconds between each account's repost
ROUND_INTERVAL  = 60             # seconds between rounds (from start of round)
CONTENT_TPL     = '转发微博{index}'  # {index} is replaced with running round number
MAX_LOOPS       = 1             # total rounds (0 = unlimited)
# ─────────────────────────────────────────────────────────

target_mid = bid_to_mid(TARGET_MBLOGID)

cookie_data = load_from_yaml('cookies.yaml', 'r')
web_cookies = cookie_data.get('cookies', {}).get('web', [])

if not web_cookies:
    raise SystemExit('No web cookies found in cookies.yaml')

clients = [WeiBoClient(web_cookie=c) for c in web_cookies]
print(f'Loaded {len(clients)} account(s).')

round_num = 1
try:
    while MAX_LOOPS == 0 or round_num <= MAX_LOOPS:
        round_start = time.time()
        print(f'\n── Round {round_num}/{MAX_LOOPS or "∞"} ──')
        for i, client in enumerate(clients, start=1):
            content = CONTENT_TPL.format(index=round_num)
            result  = client.repost_tweet(mid=target_mid, content=content)
            msg     = result.get('msg') if result else 'no response'
            print(f'  [account {i}] {msg}')
            if i < len(clients):
                time.sleep(ACCOUNT_GAP)

        round_num += 1
        if MAX_LOOPS == 0 or round_num <= MAX_LOOPS:
            elapsed = time.time() - round_start
            wait    = max(0, ROUND_INTERVAL - elapsed)
            print(f'Next round in {wait:.0f}s...')
            time.sleep(wait)

    print('All rounds completed.')
except KeyboardInterrupt:
    print('Stopped.')
