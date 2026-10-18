// 上游：window.requestAnimationFrame(function () {
//   new GameManager(4, KeyboardInputManager, HTMLActuator, LocalStorageManager);
// });
//
// 改了两处：
// 1. 存储管理器换成 ExtStorageManager（走 App 的 antiSIT storage 接口，见同目录那个文件）；
// 2. 最高分是异步读回来的，读到之后把界面上的「最高」刷一下（读到之前显示 0 不影响玩）。
window.requestAnimationFrame(function () {
  var game = new GameManager(4, KeyboardInputManager, HTMLActuator, ExtStorageManager);

  game.storageManager.whenReady(function (best) {
    var box = document.querySelector(".best-container");
    if (box && best > (parseInt(box.textContent, 10) || 0)) {
      box.textContent = best;
    }
  });
});
