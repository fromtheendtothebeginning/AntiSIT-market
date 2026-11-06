// 上游的 LocalStorageManager 换成了这一份：本地存储 → App 存储。
//
// 为什么必须换：拓展页面是 App 用 loadHtmlString 塞进 WebView 的，来源是
// **opaque origin**，读 window.localStorage 直接抛 SecurityError。上游有 try/catch
// 会退回内存版，所以游戏能开起来，但最高分关掉 App 就没了。这里改走 Cordis 的
// ctx.storage 服务，最高分真的存得住（也顺便示范「声明 storage 权限之后怎么用」）。
//
// 「继续上局」那套棋局落盘去掉了：在 App 里每次打开都从新一局开始更符合预期，
// 所以 getGameState 固定返回 null、setGameState 空实现（接口留着，游戏管理器不用改）。
function ExtStorageManager() {
  this.bestScoreKey = "bestScore";
  this._best = 0;
  this._ready = false;
  this._waiters = [];
  this._load();
}

ExtStorageManager.prototype.getBestScore = function () {
  return this._best;
};

ExtStorageManager.prototype.setBestScore = function (score) {
  this._best = score;
  // 失败时只是不落盘，别把游戏搞崩（权限没声明 / 存储不可用）。
  try {
    ctx.storage.set(this.bestScoreKey, score).catch(function () {});
  } catch (e) {}
};

// 棋局状态不落盘（见文件头）
ExtStorageManager.prototype.getGameState = function () { return null; };
ExtStorageManager.prototype.setGameState = function (gameState) {};
ExtStorageManager.prototype.clearGameState = function () {};

// 最高分是**异步**读回来的：读到之前先按 0 显示，读到之后回调里刷一下。
ExtStorageManager.prototype.whenReady = function (callback) {
  if (this._ready) {
    callback(this._best);
    return;
  }
  this._waiters.push(callback);
};

ExtStorageManager.prototype._load = function () {
  var self = this;

  function done(value) {
    self._best = typeof value === "number" ? value : (parseInt(value, 10) || 0);
    self._ready = true;
    var waiters = self._waiters;
    self._waiters = [];
    for (var i = 0; i < waiters.length; i++) {
      waiters[i](self._best);
    }
  }

  try {
    ctx.storage.get(this.bestScoreKey).then(done, function () {
      done(0);
    });
  } catch (e) {
    done(0);
  }
};
