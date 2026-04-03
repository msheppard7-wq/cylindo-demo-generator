module.exports = function handler(req, res) {
  res.status(200).json({
    has_bot_token: !!process.env.SLACK_BOT_TOKEN,
    bot_token_prefix: process.env.SLACK_BOT_TOKEN ? process.env.SLACK_BOT_TOKEN.substring(0, 8) + '...' : 'NOT SET',
    has_vercel_token: !!process.env.VERCEL_TOKEN,
    vercel_token_prefix: process.env.VERCEL_TOKEN ? process.env.VERCEL_TOKEN.substring(0, 8) + '...' : 'NOT SET',
    env_keys: Object.keys(process.env).filter(k => k.includes('SLACK') || k.includes('VERCEL') || k.includes('TOKEN')),
  });
};
