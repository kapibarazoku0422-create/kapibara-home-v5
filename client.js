// ブラウザ側に注入されるスクリプト。動的リクエスト(fetch/XHR/WS)を傍受してプロキシ経由に。
export const CLIENT_SCRIPT = `(function(){
  var PREFIX='/p/';
  var me=document.currentScript;
  var BASE=(me&&me.getAttribute('data-base'))||location.href;

  // UTF-8対応 Base64url（ASCII高速パス + メモ化）
  var ASCII=/^[\\x00-\\x7F]*$/;
  var encCache=new Map(), decCache=new Map();
  function b64enc(s){
    var hit=encCache.get(s); if(hit!==undefined) return hit;
    // URLの大半はASCII。その場合は重い encodeURIComponent を省略
    var bin=ASCII.test(s)?s:unescape(encodeURIComponent(s));
    var r=btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    if(encCache.size>2000) encCache.clear();
    encCache.set(s,r); return r;
  }
  function b64dec(s){
    var hit=decCache.get(s); if(hit!==undefined) return hit;
    var r=null;
    try{
      var t=s.replace(/-/g,'+').replace(/_/g,'/');
      while(t.length%4) t+='=';
      var bin=atob(t);
      r=ASCII.test(bin)?bin:decodeURIComponent(escape(bin));
    }catch(e){ r=null; }
    if(decCache.size>2000) decCache.clear();
    decCache.set(s,r); return r;
  }

  // 任意のURLを「元サイト基準の絶対URL」に戻す
  function toOriginal(u){
    if(u==null) return null;
    u=''+u;
    var pfx=location.origin+PREFIX;
    if(u.indexOf(pfx)===0){ var d=b64dec(u.slice(pfx.length).replace(/[?#].*$/,'')); if(d) return d; }
    if(u.indexOf(PREFIX)===0){ var d2=b64dec(u.slice(PREFIX.length).replace(/[?#].*$/,'')); if(d2) return d2; }
    if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(u)) return null;
    try{ return new URL(u, BASE).href; }catch(e){ return null; }
  }
  function toProxy(u){
    var abs=toOriginal(u);
    if(abs==null) return u;
    return PREFIX+b64enc(abs);
  }
  window.__toProxy=toProxy;

  // fetch
  var _fetch=window.fetch;
  if(_fetch){
    window.fetch=function(input,init){
      try{
        if(typeof input==='string'){ input=toProxy(input); }
        else if(input&&input.url){ input=new Request(toProxy(input.url),input); }
      }catch(e){}
      return _fetch.call(this,input,init);
    };
  }

  // XHR
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{ u=toProxy(u); }catch(e){}
    return _open.apply(this,[m,u].concat([].slice.call(arguments,2)));
  };

  // WebSocket -> プロキシ経由(ws/wss)
  var _WS=window.WebSocket;
  if(_WS){
    var WSProxy=function(url,protocols){
      try{
        var abs=toOriginal(url);
        if(abs){
          var scheme=location.protocol==='https:'?'wss:':'ws:';
          url=scheme+'//'+location.host+PREFIX+b64enc(abs);
        }
      }catch(e){}
      return protocols!==undefined?new _WS(url,protocols):new _WS(url);
    };
    WSProxy.prototype=_WS.prototype;
    WSProxy.CONNECTING=_WS.CONNECTING; WSProxy.OPEN=_WS.OPEN;
    WSProxy.CLOSING=_WS.CLOSING; WSProxy.CLOSED=_WS.CLOSED;
    window.WebSocket=WSProxy;
  }

  // sendBeacon
  if(navigator.sendBeacon){
    var _b=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(u,d){ try{u=toProxy(u);}catch(e){} return _b(u,d); };
  }

  // 動的に挿入される要素の src/href を補正
  function fixEl(el){
    if(!el||el.nodeType!==1) return;
    ['src','href'].forEach(function(a){
      if(el.hasAttribute&&el.hasAttribute(a)){
        var v=el.getAttribute(a);
        if(v&&v.indexOf(PREFIX)!==0&&!/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(v)){
          var p=toProxy(v); if(p!==v) el.setAttribute(a,p);
        }
      }
    });
  }
  try{
    var mo=new MutationObserver(function(muts){
      muts.forEach(function(m){
        if(m.type==='attributes') fixEl(m.target);
        m.addedNodes&&m.addedNodes.forEach(function(n){
          fixEl(n);
          if(n.querySelectorAll) n.querySelectorAll('[src],[href]').forEach(fixEl);
        });
      });
    });
    mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href']});
  }catch(e){}

  // history API はパスがズレないよう元に戻す
  var _ps=history.pushState, _rs=history.replaceState;
  history.pushState=function(s,t,u){ try{ if(u) u=toProxy(u);}catch(e){} return _ps.call(history,s,t,u); };
  history.replaceState=function(s,t,u){ try{ if(u) u=toProxy(u);}catch(e){} return _rs.call(history,s,t,u); };
})();`;
