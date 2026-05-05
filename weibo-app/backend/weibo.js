// weibo.js — Node.js Weibo API client
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.resolve(__dirname, '../../cookies.yaml');
const WEIBO_HTTP_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.WEIBO_HTTP_TIMEOUT_MS ?? '25000', 10) || 25_000
);

// base62 alphabet matches Python: string.digits + string.ascii_letters
// = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function base62Decode(str) {
  let num = 0n;
  for (const char of String(str)) {
    num = num * 62n + BigInt(ALPHABET.indexOf(char));
  }
  return num;
}

export function bidToMid(bid) {
  const CUT = 4, FILL = 7;
  const s = String(bid);
  const parts = [];
  for (let i = s.length; i > 0; i -= CUT) {
    parts.unshift(s.slice(Math.max(0, i - CUT), i));
  }
  return parts.map((part, i) => {
    const decoded = String(base62Decode(part));
    return i > 0 ? decoded.padStart(FILL, '0') : decoded;
  }).join('');
}

function base62Encode(num) {
  if (num === 0n) return ALPHABET[0];
  let result = '';
  while (num > 0n) {
    result = ALPHABET[Number(num % 62n)] + result;
    num = num / 62n;
  }
  return result;
}

/** Convert numeric Weibo mid → mblogid (base62 bid) */
export function midToBid(mid) {
  const CUT = 7, FILL = 4;
  const s = String(mid);
  const parts = [];
  for (let i = s.length; i > 0; i -= CUT) {
    parts.unshift(s.slice(Math.max(0, i - CUT), i));
  }
  return parts.map((part, i) => {
    const encoded = base62Encode(BigInt(part));
    return i > 0 ? encoded.padStart(FILL, ALPHABET[0]) : encoded;
  }).join('');
}

export function loadCookies() {
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  const data = yaml.load(raw);
  return data?.cookies?.web ?? [];
}

function getCookieItem(key, cookieStr) {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match ? match[1] : null;
}

function makeHeaders(cookieStr) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': cookieStr,
    'x-requested-with': 'XMLHttpRequest',
    'origin': 'https://weibo.com',
    'referer': 'https://weibo.com',
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-xsrf-token': getCookieItem('XSRF-TOKEN', cookieStr) ?? '',
  };
}

export function createClient(cookieOrIndex = 0, cookieList = null, proxy = null) {
  let cookie;
  let cookies;
  if (typeof cookieOrIndex === 'string') {
    cookie = cookieOrIndex;
    cookies = null;
  } else {
    cookies = cookieList ?? loadCookies();
    if (!cookies.length) throw new Error('No web cookies available');
    cookie = cookies[Math.min(cookieOrIndex, cookies.length - 1)];
  }
  const headers = makeHeaders(cookie);

  const agent = (proxy && typeof proxy === 'string' && proxy.trim())
    ? (() => { try { return new HttpsProxyAgent(proxy.trim()); } catch { return undefined; } })()
    : undefined;
  const proxyOpts = agent ? { httpsAgent: agent, proxy: false } : {};

  const post = (url, data) =>
    axios.post(url, new URLSearchParams(data).toString(), {
      headers,
      validateStatus: s => s < 500,
      timeout: WEIBO_HTTP_TIMEOUT_MS,
      ...proxyOpts,
    }).then(r => r.data);

  const get = (url, params = {}) =>
    axios.get(url, {
      headers,
      params,
      validateStatus: s => s < 500,
      timeout: WEIBO_HTTP_TIMEOUT_MS,
      ...proxyOpts,
    }).then(r => r.data);

  const postBinary = (url, params, binaryData) =>
    axios.post(url, binaryData, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'picupload.weibo.com',
      },
      params,
      validateStatus: s => s < 500,
      timeout: WEIBO_HTTP_TIMEOUT_MS,
      ...proxyOpts,
    }).then(r => r.data);

  return {
    accountCount: cookies?.length ?? 1,

    postTweet({ content, pid = '', mid = '', videoTitle = '', videoType = 0 }) {
      const mediaInfo = mid ? JSON.stringify({
        titles: [{ title: videoTitle, default: 'true' }],
        covers: [{ pid }],
        type: 'video',
        media_id: mid,
        resource: { video_down: 0 },
        homemade: { channel_ids: [''], type: Number(videoType) },
        approval_reprint: '1',
      }) : '{}';
      return post('https://weibo.com/ajax/statuses/update', {
        content,
        pic_id: mid ? '' : pid,
        visible: 0,
        media: mediaInfo,
        vote: '{}',
        approval_state: '0',
      });
    },

    deleteTweet({ mid }) {
      return post('https://weibo.com/ajax/statuses/destroy', { id: mid });
    },

    quickRepost({ mid }) {
      return post('https://weibo.com/ajax/statuses/repost', {
        id: mid, is_comment: 0, is_fast: 1,
      });
    },

    repostTweet({ mid, content = '转发微博', visible = 0, listId }) {
      const payload = {
        id: mid,
        comment: content,
        is_repost: 0,
        comment_ori: 0,
        is_comment: 0,
        visible: Number(visible) || 0,
      };
      const parsedListId = Number(listId);
      if (Number.isInteger(parsedListId) && parsedListId !== 0) {
        payload.list_id = parsedListId;
      }
      return post('https://weibo.com/ajax/statuses/normal_repost', payload);
    },

    commentTweet({ mid, content }) {
      return post('https://weibo.com/ajax/comments/create', { id: mid, comment: content });
    },

    replyComment({ mid, cid, content }) {
      return post('https://weibo.com/ajax/comments/reply', { id: mid, cid, comment: content });
    },

    deleteComment({ cid }) {
      return post('https://weibo.com/ajax/statuses/destroyComment', { cid });
    },

    async likeComment({ cid, rid }) {
      const objectId = rid || cid;
      if (!objectId) {
        return { ok: 0, message: 'like-comment 需要提供 cid 或评论链接' };
      }

      // Fetch fp fingerprint from Weibo page HTML (changes per page load)
      let fp = null;
      try {
        const html = await get('https://weibo.com');
        const match = String(html).match(/"fp"\s*:\s*"([^"]{10,})"/);
        if (match) fp = match[1];
      } catch { /* proceed without fp */ }

      const payload = { object_id: objectId, object_type: 'comment' };
      if (fp) payload.fp = fp;

      return post('https://weibo.com/ajax/statuses/updateLike', payload);
    },

    followUser({ uid }) {
      return post('https://weibo.com/ajax/friendships/create', { uid });
    },

    unfollowUser({ uid }) {
      return post('https://weibo.com/ajax/friendships/destory', { uid });
    },

    likeTweet({ mid }) {
      return post('https://weibo.com/ajax/statuses/setLike', { id: mid });
    },

    unlikeTweet({ mid }) {
      return post('https://weibo.com/ajax/statuses/cancelLike', { id: mid });
    },

    fetchStatusDetail({ mid }) {
      return get('https://weibo.com/ajax/statuses/show', { id: mid });
    },

    fetchFriendsTweets({ sinceId = 0 } = {}) {
      return get('https://weibo.com/ajax/feed/unreadfriendstimeline', {
        refresh: 4, since_id: sinceId, count: 15,
      });
    },

    fetchMyComments({ cursor } = {}) {
      return get('https://weibo.com/ajax/message/myCmt', cursor ? { cursor } : {});
    },

    fetchCollections() {
      return get('https://me.weibo.com/api/collection/details', { page: 1 });
    },

    fetchGroups() {
      return get('https://weibo.com/ajax/mblog/querygroup');
    },

    followSuperTopic({ topicId, name }) {
      return get('https://weibo.com/ajax/stopic/curl', {
        oid: topicId, display_name: name, is_obturate: 0,
      });
    },

    checkinSuperTopic({ topicId }) {
      // Extract the hex ID (remove "1022:" prefix if present)
      const hexId = topicId.includes(':') ? topicId.split(':')[1] : topicId;
      
      // The check-in goes through weibo.com/p/aj/general/button proxy endpoint
      // which forwards to i.huati.weibo.com/aj/super/checkin
      return get('https://weibo.com/p/aj/general/button', {
        ajwvr: 6,
        api: 'http://i.huati.weibo.com/aj/super/checkin',
        texta: '签到',
        textb: '已签到',
        status: 0,
        id: hexId,
        location: `page_${hexId.slice(0, 6)}_super_index`,
        timezone: 'GMT+0800',
        lang: 'zh-cn',
        plat: 'Win32',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
        screen: '1920*1080',
        __rnd: Date.now(),
      });
    },

    searchSuperTopics({ keyword, page = 1 } = {}) {
      return get('https://weibo.com/ajax/stopic/list', {
        sort_id: 0,
        keyword,
        page,
      });
    },

    uploadPicture(buffer, watermark = '') {
      const md5 = (() => {
        // simple md5 via crypto
        import('crypto').then(c => c.createHash('md5').update(buffer).digest('hex'));
      });
      return import('crypto').then(({ createHash }) => {
        const rawMd5 = createHash('md5').update(buffer).digest('hex');
        return postBinary(
          'https://picupload.weibo.com/interface/upload.php',
          {
            file_source: 1, ent: 'miniblog', appid: '339644097',
            raw_md5: rawMd5, ori: '1', mpos: '1', uid: '', nick: watermark,
          },
          buffer,
        );
      });
    },

    // ── inbox / notifications ──────────────────────────────

    /** Unread badge counts for all notification types (comments, @mentions, likes, follows, DMs, system). */
    fetchUnreadCounts() {
      return get('https://weibo.com/ajax/message/count');
    },

    /** Like notifications feed. Pass `sinceId` for pagination. */
    fetchLikeNotices({ sinceId = 0 } = {}) {
      return get('https://weibo.com/ajax/message/likeNotice', sinceId ? { since_id: sinceId } : {});
    },

    /** Tweets that @mention the authenticated user. Pass `sinceId` for pagination. */
    fetchAtMeTweets({ sinceId = 0 } = {}) {
      return get('https://weibo.com/ajax/statuses/mentions', sinceId ? { since_id: sinceId } : {});
    },

    /** Comments that @mention the authenticated user. Pass `sinceId` for pagination. */
    fetchAtMeComments({ sinceId = 0 } = {}) {
      return get('https://weibo.com/ajax/comments/mentions', sinceId ? { since_id: sinceId } : {});
    },

    /** Comment notification feed (comments on user's own posts). Pass `sinceId` for pagination. */
    fetchCommentNotices({ sinceId = 0 } = {}) {
      return get('https://weibo.com/ajax/message/cmt', sinceId ? { since_id: sinceId } : {});
    },

    /** Direct-message conversation list. */
    fetchDmList({ page = 1 } = {}) {
      return get('https://weibo.com/ajax/message/msglist', { page });
    },

    /** Messages in a single DM thread with `uid`. Pass `sinceId` for pagination. */
    fetchDmChat({ uid, sinceId = 0 } = {}) {
      if (!uid) throw new Error('fetchDmChat: uid is required');
      return get('https://weibo.com/ajax/message/chat', { uid, ...(sinceId ? { since_id: sinceId } : {}) });
    },

    /** Send a direct message to `uid`. */
    sendDm({ uid, content }) {
      if (!uid) throw new Error('sendDm: uid is required');
      if (!content || !String(content).trim()) throw new Error('sendDm: content is required');
      return post('https://weibo.com/ajax/message/chatSend', { uid, content: String(content).trim() });
    },
  };
}
