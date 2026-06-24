export const HOME_PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⚡ Ultra Proxy</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-family:system-ui,'Segoe UI',sans-serif;
       background:radial-gradient(circle at 30% 20%,#1e293b,#0f172a 60%,#020617);color:#e2e8f0}
  .logo{font-size:64px;margin-bottom:8px}
  h1{margin:0 0 4px;font-size:34px;font-weight:800;letter-spacing:-1px}
  p.sub{margin:0 0 32px;color:#94a3b8}
  form{display:flex;width:min(640px,90vw);gap:8px}
  input{flex:1;padding:16px 20px;border:1px solid #334155;border-radius:12px;background:#1e293b;
        color:#f1f5f9;font-size:16px;outline:none;transition:.2s}
  input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.25)}
  button{padding:0 28px;border:0;border-radius:12px;cursor:pointer;font-size:16px;font-weight:700;
         background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff}
  button:hover{filter:brightness(1.1)}
  .quick{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .quick a{padding:8px 16px;border-radius:999px;background:#1e293b;border:1px solid #334155;
           color:#cbd5e1;text-decoration:none;font-size:14px}
  .quick a:hover{border-color:#38bdf8;color:#fff}
  footer{margin-top:40px;color:#475569;font-size:13px}
</style>
</head>
<body>
  <div class="logo">⚡</div>
  <h1>Ultra Proxy</h1>
  <p class="sub">URLを入れるとプロキシ経由で表示します</p>
  <form action="/go" method="get">
    <input name="url" autofocus placeholder="example.com または https://..." autocomplete="off">
    <button type="submit">Go</button>
  </form>
  <div class="quick">
    <a href="/go?url=https://www.google.com">Google</a>
    <a href="/go?url=https://www.wikipedia.org">Wikipedia</a>
    <a href="/go?url=https://news.ycombinator.com">Hacker News</a>
    <a href="/go?url=https://example.com">example.com</a>
  </div>
  <footer>streaming · gzip/br · HTML/CSS rewrite · dynamic intercept</footer>
</body>
</html>`;
