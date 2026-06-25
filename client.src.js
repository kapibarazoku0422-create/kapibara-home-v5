/*!
 * カピバラproxy — client interceptor (browser side)
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 *
 * URLの封印(暗号化)はサーバのみが行う。ブラウザは平文URLを /__seal に渡して
 * トークンを受け取る（結果はキャッシュ）。鍵はブラウザに存在しない。
 */
(function(){
  var PREFIX='/p/';
  var me=document.currentScript;
  var BASE=(me&&me.getAttribute('data-base'))||location.href;

  // 平文絶対URL -> 封印トークン（サーバに問い合わせ、同期XHR + キャッシュ）
  var sealCache=new Map();
  function sealViaServer(abs){
    var hit=sealCache.get(abs); if(hit!==undefined) return hit;
    var token=null;
    try{
      var x=new XMLHttpRequest();
      x.open('GET','/__seal?u='+encodeURIComponent(abs),false); // 同期。結果はキャッシュされるので実質1回
      x.send();
      if(x.status===200 && x.responseText) token=x.responseText;
    }catch(e){}
    if(sealCache.size>3000) sealCache.clear();
    sealCache.set(abs,token); return token;
  }

  function isProxied(u){
    return u.indexOf(location.origin+PREFIX)===0 || u.indexOf(PREFIX)===0;
  }
  function toAbs(u){
    if(u==null) return null; u=''+u;
    if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(u)) return null;
    try{ return new URL(u, BASE).href; }catch(e){ return null; }
  }
  function toProxy(u){
    if(u==null) return u;
    var s=''+u;
    if(isProxied(s)) return s;            // 既に封印済み
    var abs=toAbs(s);
    if(abs==null) return u;               // data:等はそのまま
    var t=sealViaServer(abs);
    return t? PREFIX+t : u;               // 封印失敗時は素のまま
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
    try{
      // /__seal 自身は変換しない（無限ループ防止）
      if((''+u).indexOf('/__seal?')===-1) u=toProxy(u);
    }catch(e){}
    return _open.apply(this,[m,u].concat([].slice.call(arguments,2)));
  };

  // WebSocket -> プロキシ経由(ws/wss)
  var _WS=window.WebSocket;
  if(_WS){
    var WSProxy=function(url,protocols){
      try{
        var abs=toAbs(url);
        if(abs){
          var t=sealViaServer(abs);
          if(t){
            var scheme=location.protocol==='https:'?'wss:':'ws:';
            url=scheme+'//'+location.host+PREFIX+t;
          }
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

  // history API
  var _ps=history.pushState, _rs=history.replaceState;
  history.pushState=function(s,t,u){ try{ if(u) u=toProxy(u);}catch(e){} return _ps.call(history,s,t,u); };
  history.replaceState=function(s,t,u){ try{ if(u) u=toProxy(u);}catch(e){} return _rs.call(history,s,t,u); };
})();
