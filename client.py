#!/usr/bin/python
# coding:utf-8
"""
WeiBoClient CLI — 交互式操作客户端
用法:
    py client.py              # 显示菜单，选择要执行的操作
    py client.py all          # 依次执行所有操作（跳过需要额外输入的）
    py client.py <id>         # 直接执行某个操作，如: py client.py ac_08
"""

import sys
from weibo import WeiBoClient
from weibo.util import bid_to_mid
from weibo.consts import Video

client = WeiBoClient.load_from_file('cookies.yaml')


def ask(prompt, default=None):
    val = input(f'{prompt}{f" [{default}]" if default is not None else ""}: ').strip()
    return val if val else default


def to_mid(val):
    """Accept either a numeric mid or a mblogid (URL last segment)."""
    if str(val).isdigit():
        return int(val)
    return bid_to_mid(val)


# ── operations ────────────────────────────────────────────────────────────────

def ac_00():
    """上传图片"""
    path = ask('图片路径')
    result = client.upload_picture(path)
    pid = result.get('pic', {}).get('pid')
    print(f'  → pid: {pid}')

def ac_01():
    """上传视频"""
    path = ask('视频路径')
    result = client.upload_video(path)
    print(f'  → media_id: {result.get("media_id")}, cover_pid: {result.get("cover_pid")}')

def ac_02():
    """获取当前用户创建的所有视频合集"""
    result = client.fetch_user_collections()
    print(f'  → {result}')

def ac_03():
    """获取当前用户加入的所有群组"""
    result = client.fetch_user_groups()
    print(f'  → {result}')

def ac_04():
    """关注超话"""
    topic_id = ask('超话 topic_id')
    name     = ask('超话名称')
    result   = client.follow_super_topic(topic_id=topic_id, name=name)
    print(f'  → {result}')

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
    print(f'  → mid: {result.get("data", {}).get("mid")}, msg: {result.get("msg")}')

def ac_06():
    """删除微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.delete_tweet(mid=mid)
    print(f'  → {result}')

def ac_07():
    """快转微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.quick_repost_tweet(mid=mid)
    print(f'  → {result}')

def ac_08():
    """转发微博"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    content = ask('转发内容', '转发微博')
    result  = client.repost_tweet(mid=mid, content=content)
    print(f'  → msg: {result.get("msg")}')

def ac_09():
    """评论微博"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    content = ask('评论内容')
    result  = client.comment_tweet(mid=mid, content=content)
    cid     = result.get('data', {}).get('id')
    print(f'  → cid: {cid}, msg: {result.get("msg")}')

def ac_10():
    """回复评论"""
    mid     = to_mid(ask('微博 mid 或 mblogid'))
    cid     = ask('评论 cid')
    content = ask('回复内容')
    result  = client.reply_to_comment(mid=mid, cid=cid, content=content)
    print(f'  → msg: {result.get("msg")}')

def ac_11():
    """删除评论"""
    cid    = ask('评论 cid')
    result = client.delete_comment(cid=cid)
    print(f'  → {result}')

def ac_12():
    """关注用户"""
    uid    = ask('用户 uid')
    result = client.follow_user(uid=uid)
    print(f'  → {result}')

def ac_13():
    """取关用户"""
    uid    = ask('用户 uid')
    result = client.unfollow_user(uid=uid)
    print(f'  → {result}')

def ac_14():
    """点赞微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.like_tweet(mid=mid)
    print(f'  → {result}')

def ac_15():
    """取消点赞微博"""
    mid    = to_mid(ask('微博 mid 或 mblogid'))
    result = client.unlike_tweet(mid=mid)
    print(f'  → {result}')

def ac_16():
    """获取当前用户关注的朋友新发布的微博"""
    since_id = ask('since_id（翻页，首次留空）', 0)
    result   = client.fetch_my_friends_tweets(since_id=since_id)
    count    = len(result) if isinstance(result, list) else '?'
    print(f'  → 获取 {count} 条')

def ac_17():
    """获取当前用户发出过的评论"""
    cursor = ask('cursor（翻页，首次留空）', None)
    result = client.fetch_my_comments(cursor=cursor if cursor else None)
    print(f'  → {result}')


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

# operations that need no interactive input (safe to run in 'all' mode)
AUTO_SAFE = {'ac_02', 'ac_03', 'ac_16', 'ac_17'}


def print_menu():
    print('\n══════════════ WeiBoClient ══════════════')
    for key, fn in OPERATIONS.items():
        print(f'  {key}  {fn.__doc__}')
    print('  all  执行所有免输入操作')
    print('  q    退出')
    print('═════════════════════════════════════════')


def run_one(key):
    fn = OPERATIONS.get(key)
    if not fn:
        print(f'未知操作: {key}')
        return
    print(f'\n▶ {key} — {fn.__doc__}')
    try:
        fn()
    except Exception as e:
        print(f'  ✗ 错误: {e}')


def run_all():
    for key in AUTO_SAFE:
        run_one(key)


def interactive():
    print_menu()
    while True:
        choice = input('\n请输入操作编号 (或 all / q): ').strip().lower()
        if choice in ('q', 'quit', 'exit'):
            break
        elif choice == 'all':
            run_all()
        elif choice in OPERATIONS:
            run_one(choice)
        else:
            print('  无效输入，请重试。')


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        interactive()
    elif args[0] == 'all':
        run_all()
    elif args[0] in OPERATIONS:
        run_one(args[0])
    else:
        print(f'未知操作: {args[0]}')
        print(f'可用操作: {", ".join(OPERATIONS)} | all')
        sys.exit(1)
