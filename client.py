#!/usr/bin/python
# coding:utf-8
"""
WeiBoClient CLI — 交互式操作客户端
用法:
    py client.py                     # 显示菜单，选择要执行的操作
    py client.py all                 # 依次执行所有免输入操作（使用默认值）
    py client.py <id> [<id> ...]     # 直接执行一个或多个操作，如: py client.py ac_08 ac_09
    py client.py --dry-run <id>      # 显示参数预览，不实际发送请求
    py client.py --list              # 列出所有操作后退出
"""

import sys
import json

# ── readline (history + tab-complete) ────────────────────────────────────────
try:
    import readline
    readline.parse_and_bind('tab: complete')
except ImportError:
    try:
        import pyreadline3  # noqa: F401  Windows fallback
    except ImportError:
        pass  # no history; not fatal

# ── colorama (optional colors) ───────────────────────────────────────────────
try:
    from colorama import init as _cinit, Fore, Style
    _cinit(autoreset=True)
    _HAS_COLOR = True
except ImportError:
    _HAS_COLOR = False
    class _Dummy:
        def __getattr__(self, _): return ''
    Fore = Style = _Dummy()

def _ok(t):  return f'{Fore.GREEN}{t}{Style.RESET_ALL}'  if _HAS_COLOR else t
def _err(t): return f'{Fore.RED}{t}{Style.RESET_ALL}'    if _HAS_COLOR else t
def _hi(t):  return f'{Fore.YELLOW}{t}{Style.RESET_ALL}' if _HAS_COLOR else t
def _dim(t): return f'{Fore.CYAN}{t}{Style.RESET_ALL}'   if _HAS_COLOR else t

# ── known auth-failure errno codes ───────────────────────────────────────────
_AUTH_ERRNOS = {100005, 100001, 20016}

# ── execution mode flag ───────────────────────────────────────────────────────
# 'normal' | 'auto' (all-mode, uses defaults) | 'dry_run'
_EXEC_MODE = 'normal'

from weibo import WeiBoClient
from weibo.util import bid_to_mid
from weibo.consts import Video

client = WeiBoClient.load_from_file('cookies.yaml')


def ask(prompt, default=None):
    """Prompt the user, honouring auto/dry-run modes."""
    if _EXEC_MODE in ('auto', 'dry_run'):
        val = default
        print(f'  {_dim(f"[skip] {prompt} = {val!r}")}')
        return val
    try:
        val = input(f'{_hi(prompt)}{f" [{default}]" if default is not None else ""}: ').strip()
    except (EOFError, KeyboardInterrupt):
        print()
        raise
    return val if val else default


def to_mid(val):
    """Accept either a numeric mid or a mblogid (URL last segment)."""
    s = str(val).strip()
    if s.isdigit():
        return int(s)
    try:
        return bid_to_mid(s)
    except Exception:
        raise ValueError(f'无法解析为 mid/mblogid: {val!r}')


# ── shared result printer ─────────────────────────────────────────────────────

def _check_auth(result):
    """Return True and print a hint when the result signals an expired cookie."""
    if not isinstance(result, dict):
        return False
    errno = result.get('errno') or result.get('error_code')
    if result.get('ok') == 0 and errno in _AUTH_ERRNOS:
        print(_err(f'  ✗ Cookie 已过期（errno={errno}），请更新 cookies.yaml'))
        return True
    return False


def print_result(result):
    """Pretty-print an API result with auth-expiry detection."""
    if _EXEC_MODE == 'dry_run':
        print(_dim('  [dry-run] 跳过实际请求'))
        return
    if _check_auth(result):
        return
    if isinstance(result, dict):
        msg    = result.get('msg') or result.get('message')
        ok_val = result.get('ok')
        prefix = _ok('  ✓') if ok_val == 1 or ok_val is True else (_err('  ✗') if ok_val == 0 else _dim('  →'))
        parts  = []
        if msg:
            parts.append(f'msg: {msg}')
        data = result.get('data')
        if isinstance(data, dict):
            for key in ('mid', 'id', 'uid', 'pid', 'mblogid', 'cid'):
                if data.get(key):
                    parts.append(f'{key}: {data[key]}')
        elif isinstance(data, list):
            parts.append(f'{len(data)} 条记录')
        if parts:
            print(f'{prefix} {" · ".join(parts)}')
        else:
            raw = json.dumps(result, ensure_ascii=False)
            print(f'{prefix} {raw[:400]}{"…" if len(raw) > 400 else ""}')
    elif isinstance(result, list):
        print(_ok(f'  ✓ 共 {len(result)} 条'))
    else:
        print(_dim(f'  → {result}'))


# ── auto_safe decorator ───────────────────────────────────────────────────────

def auto_safe(fn):
    """Mark an operation as safe to run without interactive input ('all' mode)."""
    fn._auto_safe = True
    return fn


# ── operations ────────────────────────────────────────────────────────────────

def ac_00():
    """上传图片"""
    path   = ask('图片路径')
    result = client.upload_picture(path)
    pid    = result.get('pic', {}).get('pid')
    print(_ok(f'  ✓ pid: {pid}'))

def ac_01():
    """上传视频"""
    path   = ask('视频路径')
    result = client.upload_video(path)
    print(_ok(f'  ✓ media_id: {result.get("media_id")}, cover_pid: {result.get("cover_pid")}'))

@auto_safe
def ac_02():
    """获取当前用户创建的所有视频合集"""
    result = client.fetch_user_collections()
    print_result(result)

@auto_safe
def ac_03():
    """获取当前用户加入的所有群组"""
    result = client.fetch_user_groups()
    print_result(result)

def ac_04():
    """关注超话"""
    topic_id = ask('超话 topic_id')
    name     = ask('超话名称')
    result   = client.follow_super_topic(topic_id=topic_id, name=name)
    print_result(result)

def ac_04_1():
    """超话签到"""
    topic_id = ask('超话 topic_id')
    result   = client.checkin_super_topic(topic_id=topic_id)
    print_result(result)

def ac_04_2():
    """超话签到（按名称）"""
    name   = ask('超话名称')
    result = client.checkin_super_topic_by_name(name=name)
    print_result(result)

def ac_05():
    """发布微博"""
    print('  类型: 1=纯文字  2=图片  3=视频')
    t       = ask('选择类型', '1')
    content = ask('微博内容')
    if t == '1':
        result = client.post_tweet(content=content)
    elif t == '2':
        pid    = ask('图片 pid（多图逗号分隔）')
        result = client.post_tweet(content=content, pid=pid)
    else:
        media_id  = ask('视频 media_id')
        cover_pid = ask('封面 pid')
        title     = ask('视频标题', '')
        result    = client.post_tweet(content=content, pid=cover_pid,
                                      mid=media_id, video_title=title,
                                      video_type=Video.ORIGINAL)
    print_result(result)

def ac_06():
    """删除微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.delete_tweet(mid=mid)
    print_result(result)

def ac_07():
    """快转微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.quick_repost_tweet(mid=mid)
    print_result(result)

def ac_08():
    """转发微博"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    content = ask('转发内容', '转发微博')
    result  = client.repost_tweet(mid=mid, content=content)
    print_result(result)

def ac_09():
    """评论微博"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    content = ask('评论内容')
    result  = client.comment_tweet(mid=mid, content=content)
    print_result(result)

def ac_10():
    """回复评论"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    cid     = ask('评论 cid')
    content = ask('回复内容')
    result  = client.reply_to_comment(mid=mid, cid=cid, content=content)
    print_result(result)

def ac_11():
    """删除评论"""
    cid    = ask('评论 cid')
    result = client.delete_comment(cid=cid)
    print_result(result)

def ac_12():
    """关注用户"""
    uid    = ask('用户 uid')
    result = client.follow_user(uid=uid)
    print_result(result)

def ac_13():
    """取关用户"""
    uid    = ask('用户 uid')
    result = client.unfollow_user(uid=uid)
    print_result(result)

def ac_14():
    """点赞微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.like_tweet(mid=mid)
    print_result(result)

def ac_15():
    """取消点赞微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.unlike_tweet(mid=mid)
    print_result(result)

@auto_safe
def ac_16():
    """获取当前用户关注的朋友新发布的微博"""
    since_id = ask('since_id（翻页，首次留空）', 0)
    result   = client.fetch_my_friends_tweets(since_id=since_id)
    count    = len(result) if isinstance(result, list) else '?'
    print(_ok(f'  ✓ 获取 {count} 条'))

@auto_safe
def ac_17():
    """获取当前用户发出过的评论"""
    cursor = ask('cursor（翻页，首次留空）', None)
    result = client.fetch_my_comments(cursor=cursor if cursor else None)
    print_result(result)


# ── registry ──────────────────────────────────────────────────────────────────

OPERATIONS = {
    'ac_00': ac_00,
    'ac_01': ac_01,
    'ac_02': ac_02,
    'ac_03': ac_03,
    'ac_04': ac_04,
    'ac_05': ac_05,
    'ac_06': ac_06,
    'ac_07': ac_07,
    'ac_08': ac_08,
    'ac_09': ac_09,
    'ac_10': ac_10,
    'ac_11': ac_11,
    'ac_12': ac_12,
    'ac_13': ac_13,
    'ac_14': ac_14,
    'ac_15': ac_15,
    'ac_16': ac_16,
    'ac_17': ac_17,
}

# Derived from @auto_safe decorator — no need to maintain manually
AUTO_SAFE = {k for k, fn in OPERATIONS.items() if getattr(fn, '_auto_safe', False)}


def print_menu():
    print(_hi('\n══════════════ WeiBoClient ══════════════'))
    for key, fn in OPERATIONS.items():
        tag = _dim(' [auto]') if key in AUTO_SAFE else ''
        print(f'  {_ok(key)}  {fn.__doc__}{tag}')
    print(f'  {_ok("all")}  执行所有标 [auto] 的操作（使用默认值）')
    print(f'  {_ok("q")}    退出')
    print(_hi('═════════════════════════════════════════'))


def run_one(key, *, dry_run=False):
    global _EXEC_MODE
    fn = OPERATIONS.get(key)
    if not fn:
        print(_err(f'未知操作: {key}'))
        return
    print(f'\n▶ {_ok(key)} — {fn.__doc__}' + (_dim(' [dry-run]') if dry_run else ''))
    prev = _EXEC_MODE
    if dry_run:
        _EXEC_MODE = 'dry_run'
    try:
        fn()
    except (EOFError, KeyboardInterrupt):
        print(_err('\n  中断'))
    except ValueError as e:
        print(_err(f'  ✗ 输入错误: {e}'))
    except Exception as e:
        print(_err(f'  ✗ 错误: {e}'))
    finally:
        _EXEC_MODE = prev


def run_all():
    global _EXEC_MODE
    prev = _EXEC_MODE
    _EXEC_MODE = 'auto'
    try:
        for key in AUTO_SAFE:
            run_one(key)
    finally:
        _EXEC_MODE = prev


def interactive():
    print_menu()
    while True:
        try:
            choice = input(_hi('\n请输入操作编号 (或 all / q): ')).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if choice in ('q', 'quit', 'exit'):
            break
        elif choice == 'all':
            run_all()
        elif choice in OPERATIONS:
            run_one(choice)
        else:
            print(_err('  无效输入，请重试。'))


if __name__ == '__main__':
    args = sys.argv[1:]

    # --list / --help
    if not args or args[0] in ('--list', '--help', '-h'):
        if args and args[0] != '--list':
            print(__doc__)
        else:
            print_menu()
        sys.exit(0)

    # --dry-run <id> [<id> ...]
    if args[0] == '--dry-run':
        targets = args[1:]
        if not targets:
            print(_err('用法: py client.py --dry-run <id> [<id> ...]'))
            sys.exit(1)
        for key in targets:
            if key not in OPERATIONS:
                print(_err(f'未知操作: {key}'))
            else:
                run_one(key, dry_run=True)
        sys.exit(0)

    # all
    if args[0] == 'all':
        run_all()
        sys.exit(0)

    # one or more operation ids
    unknown = [a for a in args if a not in OPERATIONS]
    if unknown:
        print(_err(f'未知操作: {", ".join(unknown)}'))
        print(f'可用操作: {", ".join(OPERATIONS)} | all')
        sys.exit(1)

    for key in args:
        run_one(key)

