// Operation definitions — edit labels, placeholders, and endpoints here
export const OPERATIONS = [
  {
    id: 'post-tweet',
    label: '发布微博',
    group: '微博',
    endpoint: '/api/post-tweet',
    method: 'POST',
    fields: [
      { name: 'content', label: '内容', type: 'textarea', required: true, placeholder: '说点什么吧... 支持[表情] @用户 #话题#' },
      { name: 'pid', label: '图片PID（可选，多图逗号分隔）', type: 'text', placeholder: '008syIOLly1xxx,008syIOLlyxxx' },
      { name: 'mid', label: '视频Media ID（可选）', type: 'text', placeholder: '发视频微博时填写' },
      { name: 'videoTitle', label: '视频标题（可选）', type: 'text' },
    ],
  },
  {
    id: 'delete-tweet',
    label: '删除微博',
    group: '微博',
    endpoint: '/api/delete-tweet',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
    ],
  },
  {
    id: 'quick-repost',
    label: '快转微博',
    group: '微博',
    endpoint: '/api/quick-repost',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
    ],
  },
  {
    id: 'repost-tweet',
    label: '转发微博',
    group: '微博',
    endpoint: '/api/repost-tweet',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
      { name: 'content', label: '转发内容', type: 'textarea', placeholder: '转发微博' },
      {
        name: 'visible',
        label: '可见权限',
        type: 'select',
        default: '0',
        options: [
          { value: '0', label: '公开' },
          { value: '10', label: '粉丝可见' },
          { value: '6', label: '好友圈可见' },
          { value: '1', label: '仅自己可见' },
          { value: '5', label: '群可见' },
        ],
      },
      {
        name: 'listId',
        label: '群 list_id（仅群可见 type=5 时填写）',
        type: 'text',
        placeholder: '例如: 2',
      },
    ],
  },
  {
    id: 'comment-tweet',
    label: '评论微博',
    group: '评论',
    endpoint: '/api/comment-tweet',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
      { name: 'content', label: '评论内容', type: 'textarea', required: true },
    ],
  },
  {
    id: 'reply-comment',
    label: '回复评论',
    group: '评论',
    endpoint: '/api/reply-comment',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
      { name: 'cid', label: '评论 CID', type: 'text', required: true, placeholder: '评论ID' },
      { name: 'content', label: '回复内容', type: 'textarea', required: true },
    ],
  },
  {
    id: 'delete-comment',
    label: '删除评论',
    group: '评论',
    endpoint: '/api/delete-comment',
    method: 'POST',
    fields: [
      { name: 'cid', label: '评论 CID', type: 'text', required: true, placeholder: '评论ID' },
    ],
  },
  {
    id: 'like-comment',
    label: '点赞评论',
    group: '评论',
    endpoint: '/api/like-comment',
    method: 'POST',
    fields: [
      { name: 'cid', label: '评论 CID / 评论链接', type: 'text', required: true, placeholder: '5293554101914702 或 https://weibo.com/3193185443/QDcZJ3O6e?cid=5293554101914702&rid=5293573663624500' },
    ],
  },
  {
    id: 'batch-like-comment',
    label: '批量点赞评论',
    group: '评论',
    endpoint: '/api/batch-like-comment-stream',
    method: 'POST',
    isBatch: true,
    fields: [
      { name: 'cids', label: '评论 CID / 链接列表（每行一个）', type: 'textarea', required: true, placeholder: '5293554101914702\nhttps://weibo.com/.../QD...?cid=5293566173645208&rid=5293573663624500' },
    ],
  },
  {
    id: 'follow-user',
    label: '关注用户',
    group: '社交',
    endpoint: '/api/follow-user',
    method: 'POST',
    fields: [
      { name: 'uid', label: '用户 UID', type: 'text', required: true, placeholder: '用户数字ID' },
    ],
  },
  {
    id: 'unfollow-user',
    label: '取关用户',
    group: '社交',
    endpoint: '/api/unfollow-user',
    method: 'POST',
    fields: [
      { name: 'uid', label: '用户 UID', type: 'text', required: true, placeholder: '用户数字ID' },
    ],
  },
  {
    id: 'like-tweet',
    label: '点赞微博',
    group: '社交',
    endpoint: '/api/like-tweet',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
    ],
  },
  {
    id: 'unlike-tweet',
    label: '取消点赞',
    group: '社交',
    endpoint: '/api/unlike-tweet',
    method: 'POST',
    fields: [
      { name: 'mid', label: '微博 MID / MBlogID / UID·MBlogID', type: 'text', required: true, placeholder: '5293018016122857 或 QDfJQCThw 或 1234567/QDfJQCThw', weiboRef: true },
    ],
  },
  {
    id: 'follow-super-topic',
    label: '关注超话',
    group: '社交',
    endpoint: '/api/follow-super-topic',
    method: 'POST',
    fields: [
      { name: 'topicId', label: '超话 Topic ID', type: 'text', required: true },
      { name: 'name', label: '超话名称', type: 'text', required: true },
    ],
  },
  {
    id: 'checkin-super-topic-by-name',
    label: '超话签到（按名称）',
    group: '社交',
    endpoint: '/api/checkin-super-topic-by-name',
    method: 'POST',
    fields: [
      { name: 'name', label: '超话名称', type: 'text', required: true, placeholder: '输入超话名称进行签到' },
    ],
  },
  {
    id: 'friends-tweets',
    label: '好友新微博',
    group: '获取',
    endpoint: '/api/friends-tweets',
    method: 'GET',
    fields: [
      { name: 'sinceId', label: 'Since ID（翻页，首次留空）', type: 'text', placeholder: '0' },
    ],
  },
  {
    id: 'my-comments',
    label: '我发出的评论',
    group: '获取',
    endpoint: '/api/my-comments',
    method: 'GET',
    fields: [
      { name: 'cursor', label: 'Cursor（翻页，首次留空）', type: 'text' },
    ],
  },
  {
    id: 'collections',
    label: '我的视频合集',
    group: '获取',
    endpoint: '/api/collections',
    method: 'GET',
    fields: [],
  },
  {
    id: 'groups',
    label: '我加入的群组',
    group: '获取',
    endpoint: '/api/groups',
    method: 'GET',
    fields: [],
  },
  {
    id: 'upload-picture',
    label: '上传图片',
    group: '上传',
    endpoint: '/api/upload-picture',
    method: 'UPLOAD',
    fields: [
      { name: 'image', label: '选择图片', type: 'file', required: true, accept: 'image/*' },
      { name: 'watermark', label: '水印文字（可选）', type: 'text', placeholder: '@某个用户' },
    ],
  },
];

export const GROUPS = [...new Set(OPERATIONS.map(o => o.group))];

export const BATCH_SUPPORTED_ENDPOINTS = new Set([
  '/api/post-tweet', '/api/delete-tweet', '/api/quick-repost', '/api/repost-tweet',
  '/api/comment-tweet', '/api/reply-comment', '/api/delete-comment', '/api/like-comment',
  '/api/follow-user', '/api/unfollow-user', '/api/like-tweet', '/api/unlike-tweet',
  '/api/follow-super-topic', '/api/checkin-super-topic-by-name', '/api/batch-like-comment-stream',
]);

export const SCHEDULABLE_OPERATIONS = OPERATIONS.filter(o => BATCH_SUPPORTED_ENDPOINTS.has(o.endpoint));

// Fields that support random copywriting injection
export const RANDOM_FIELDS = new Set(['content']);

// Operations where random copywriting makes sense (has a 'content' field)
export const RANDOM_SUPPORTED_OPS = new Set(
  OPERATIONS.filter(o => o.fields.some(f => RANDOM_FIELDS.has(f.name))).map(o => o.endpoint)
);
