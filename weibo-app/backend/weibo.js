// weibo.js — Node.js Weibo API client
import axios from 'axios';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.resolve(__dirname, '../../cookies.yaml');

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

export function createClient(cookieOrIndex = 0, cookieList = null) {
  let cookie;
  if (typeof cookieOrIndex === 'string') {
    cookie = cookieOrIndex;
  } else {
    const cookies = cookieList ?? loadCookies();
    if (!cookies.length) throw new Error('No web cookies available');
    cookie = cookies[Math.min(cookieOrIndex, cookies.length - 1)];
  }
  const headers = makeHeaders(cookie);

  const post = (url, data) =>
    axios.post(url, new URLSearchParams(data).toString(), {
      headers,
      validateStatus: s => s < 500,
    }).then(r => r.data);

  const get = (url, params = {}) =>
    axios.get(url, { headers, params, validateStatus: s => s < 500 }).then(r => r.data);

  const postBinary = (url, params, binaryData) =>
    axios.post(url, binaryData, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'picupload.weibo.com',
      },
      params,
      validateStatus: s => s < 500,
    }).then(r => r.data);

  return {
    accountCount: cookies.length,

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

    repostTweet({ mid, content = '转发微博' }) {
      return post('https://weibo.com/ajax/statuses/normal_repost', {
        id: mid, comment: content, is_repost: 0, comment_ori: 0, is_comment: 0, visible: 0,
      });
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
  };
}
