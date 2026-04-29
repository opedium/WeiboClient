#!/usr/bin/python
# coding:utf-8
"""
示例脚本：演示 WeiBoClient 所有常用操作接口
运行前请确保 cookies.yaml 中已配置有效的 web cookie。
"""

from weibo import WeiBoClient
from weibo.util import bid_to_mid
from weibo.consts import Video, Visible

client = WeiBoClient.load_from_file('cookies.yaml')

# ─────────────────────────────────────────────────────────────────────────────
# ac_00  上传图片
# 返回结果中 result['pic']['pid'] 为后续发微博使用的图片id
# ─────────────────────────────────────────────────────────────────────────────
def ac_00_upload_picture(pic_path: str):
    result = client.upload_picture(pic_path)
    pid = result.get('pic', {}).get('pid')
    print(f'[上传图片] pid: {pid}')
    return pid


# ─────────────────────────────────────────────────────────────────────────────
# ac_01  上传视频
# 返回结果中包含 media_id（发视频微博用）和 cover_pid（封面图pid）
# ─────────────────────────────────────────────────────────────────────────────
def ac_01_upload_video(video_path: str):
    result = client.upload_video(video_path)
    media_id  = result.get('media_id')
    cover_pid = result.get('cover_pid')
    print(f'[上传视频] media_id: {media_id}, cover_pid: {cover_pid}')
    return media_id, cover_pid


# ─────────────────────────────────────────────────────────────────────────────
# ac_02  获取当前用户创建的所有视频合集
# ─────────────────────────────────────────────────────────────────────────────
def ac_02_fetch_user_collections():
    result = client.fetch_user_collections()
    print(f'[视频合集] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_03  获取当前用户加入的所有群组
# ─────────────────────────────────────────────────────────────────────────────
def ac_03_fetch_user_groups():
    result = client.fetch_user_groups()
    print(f'[用户群组] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_04  关注超话
# topic_id 和 name 可通过 client.fetch_super_topics() 获取
# ─────────────────────────────────────────────────────────────────────────────
def ac_04_follow_super_topic(topic_id: str, name: str):
    result = client.follow_super_topic(topic_id=topic_id, name=name)
    print(f'[关注超话] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_05  发布微博（纯文字 / 图片 / 视频）
# ─────────────────────────────────────────────────────────────────────────────
def ac_05_post_tweet_text(content: str):
    """纯文字微博"""
    result = client.post_tweet(content=content)
    mid = result.get('data', {}).get('mid')
    print(f'[发布文字微博] mid: {mid}, msg: {result.get("msg")}')
    return mid

def ac_05_post_tweet_with_pic(content: str, pid: str):
    """图片微博，pid 由 ac_00_upload_picture 获得"""
    result = client.post_tweet(content=content, pid=pid)
    mid = result.get('data', {}).get('mid')
    print(f'[发布图片微博] mid: {mid}, msg: {result.get("msg")}')
    return mid

def ac_05_post_tweet_with_video(content: str, media_id: str, cover_pid: str,
                                 video_title: str = ''):
    """视频微博，media_id 和 cover_pid 由 ac_01_upload_video 获得"""
    result = client.post_tweet(
        content=content,
        pid=cover_pid,
        mid=media_id,
        video_title=video_title,
        video_type=Video.ORIGINAL,
    )
    mid = result.get('data', {}).get('mid')
    print(f'[发布视频微博] mid: {mid}, msg: {result.get("msg")}')
    return mid


# ─────────────────────────────────────────────────────────────────────────────
# ac_06  删除微博
# ─────────────────────────────────────────────────────────────────────────────
def ac_06_delete_tweet(mid):
    result = client.delete_tweet(mid=mid)
    print(f'[删除微博] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_07  快转微博（一键转发，无附加文字）
# ─────────────────────────────────────────────────────────────────────────────
def ac_07_quick_repost(mid):
    result = client.quick_repost_tweet(mid=mid)
    print(f'[快转微博] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_08  转发微博（可附加文字）
# ─────────────────────────────────────────────────────────────────────────────
def ac_08_repost_tweet(mid, content: str = '转发微博'):
    result = client.repost_tweet(mid=mid, content=content)
    print(f'[转发微博] msg: {result.get("msg")}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_09  评论微博
# ─────────────────────────────────────────────────────────────────────────────
def ac_09_comment_tweet(mid, content: str):
    result = client.comment_tweet(mid=mid, content=content)
    cid = result.get('data', {}).get('id')
    print(f'[评论微博] cid: {cid}, msg: {result.get("msg")}')
    return cid


# ─────────────────────────────────────────────────────────────────────────────
# ac_10  回复评论
# cid 为要回复的评论id，可由 ac_09 返回值获得
# ─────────────────────────────────────────────────────────────────────────────
def ac_10_reply_comment(mid, cid, content: str):
    result = client.reply_to_comment(mid=mid, cid=cid, content=content)
    print(f'[回复评论] {result.get("msg")}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_11  删除评论
# ─────────────────────────────────────────────────────────────────────────────
def ac_11_delete_comment(cid):
    result = client.delete_comment(cid=cid)
    print(f'[删除评论] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_12  关注用户
# ─────────────────────────────────────────────────────────────────────────────
def ac_12_follow_user(uid):
    result = client.follow_user(uid=uid)
    print(f'[关注用户] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_13  取关用户
# ─────────────────────────────────────────────────────────────────────────────
def ac_13_unfollow_user(uid):
    result = client.unfollow_user(uid=uid)
    print(f'[取关用户] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_14  点赞微博
# ─────────────────────────────────────────────────────────────────────────────
def ac_14_like_tweet(mid):
    result = client.like_tweet(mid=mid)
    print(f'[点赞微博] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_15  取消点赞微博
# ─────────────────────────────────────────────────────────────────────────────
def ac_15_unlike_tweet(mid):
    result = client.unlike_tweet(mid=mid)
    print(f'[取消点赞] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_16  获取当前用户关注的朋友新发布的微博
# ─────────────────────────────────────────────────────────────────────────────
def ac_16_fetch_friends_tweets(since_id=0):
    result = client.fetch_my_friends_tweets(since_id=since_id)
    print(f'[好友微博] 获取 {len(result) if isinstance(result, list) else "?"} 条')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ac_17  获取当前用户发出过的评论
# ─────────────────────────────────────────────────────────────────────────────
def ac_17_fetch_my_comments(cursor=None):
    result = client.fetch_my_comments(cursor=cursor)
    print(f'[我的评论] {result}')
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 示例调用（按需取消注释）
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    # URL 末段 mblogid → 数字 mid
    target_mid = bid_to_mid('QCv7TyBL0')

    # ac_05  发布纯文字微博
    # ac_05_post_tweet_text('Hello from WeiBoClient!')

    # ac_08  转发微博
    # ac_08_repost_tweet(target_mid, content='转发微博')

    # ac_09  评论微博
    # cid = ac_09_comment_tweet(target_mid, '好帖！')

    # ac_10  回复评论（需要先有 cid）
    # ac_10_reply_comment(target_mid, cid, '同意！')

    # ac_14  点赞
    # ac_14_like_tweet(target_mid)

    # ac_16  获取好友新微博
    # ac_16_fetch_friends_tweets()

    # ac_17  获取我发出的评论
    # ac_17_fetch_my_comments()

    print('取消注释想要调用的函数后重新运行。')
