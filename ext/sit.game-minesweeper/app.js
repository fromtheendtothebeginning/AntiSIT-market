// 改编自 kubowania/minesweeper（MIT，Copyright (c) 2020 Ania Kubow）
// 上游：https://github.com/kubowania/minesweeper —— master @ a88b0eb0f9da16836dd551ff8cee0a2bdaffef7c
// 改动清单见同目录 NOTICE.md。主要四处：
//   1. 邻格统计与翻开（flood fill）改成按行列算，修掉上游写死的 9/10/11/88/89/90/98 带来的边界数错；
//   2. 触屏：加「🚩 标记」模式 + 长按插旗（触屏没有右键），桌面右键照旧；
//   3. 双击已翻开的数字格：周围旗数对得上就自动翻开其余邻格（跟桌面扫雷的双击/中键一致）；
//   4. 加计时器、重来按钮、中文文案；顺带把「把所有非雷格子翻开」也算赢（上游只在插满旗时判赢）。
document.addEventListener('DOMContentLoaded', () => {
  const width = 10
  const bombAmount = 20

  const grid = document.querySelector('.grid')
  const flagsLeft = document.querySelector('#flags-left')
  const timeEl = document.querySelector('#time')
  const result = document.querySelector('#result')
  const flagButton = document.querySelector('#flag-mode')
  const restartButton = document.querySelector('#restart')

  let squares = []
  let flags = 0
  let isGameOver = false
  let flagMode = false
  let started = false
  let seconds = 0
  let timerId = null

  // 双击检测：记上一次点在哪个格子、什么时候、点之前是不是已经翻开了
  let lastTapId = -1
  let lastTapAt = 0
  let lastTapWasOpen = false

  // ---- 棋盘 ----

  function createBoard() {
    grid.innerHTML = ''
    squares = []
    flags = 0
    isGameOver = false
    started = false
    stopTimer()
    seconds = 0
    result.textContent = ''
    lastTapId = -1
    lastTapAt = 0
    lastTapWasOpen = false
    renderStatus()

    // 上游同款：随机撒雷（洗牌）
    const bombsArray = Array(bombAmount).fill('bomb')
    const emptyArray = Array(width * width - bombAmount).fill('valid')
    const gameArray = emptyArray.concat(bombsArray)
    const shuffledArray = gameArray.sort(() => Math.random() - 0.5)

    for (let i = 0; i < width * width; i++) {
      const square = document.createElement('div')
      square.setAttribute('id', i)
      square.className = 'cell ' + shuffledArray[i]
      grid.appendChild(square)
      squares.push(square)
      bindSquare(square)
    }

    // 数字：遍历 8 个邻格，比上游那 8 个 if 条件短也更准
    for (let i = 0; i < squares.length; i++) {
      if (!squares[i].classList.contains('valid')) continue
      let total = 0
      neighbours(i).forEach(function (j) {
        if (squares[j].classList.contains('bomb')) total++
      })
      squares[i].setAttribute('data', total)
    }
  }

  // 一个格子的 8 个邻格下标（按行列算，边界自然正确处理）
  function neighbours(index) {
    const row = Math.floor(index / width)
    const col = index % width
    const out = []
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= width || c < 0 || c >= width) continue
        out.push(r * width + c)
      }
    }
    return out
  }

  // ---- 操作 ----

  function bindSquare(square) {
    let pressTimer = null
    let longPressed = false
    let moved = false
    let startX = 0
    let startY = 0
    let lastTouchAt = 0

    function cancelPress() {
      clearTimeout(pressTimer)
      pressTimer = null
      square.classList.remove('pressing')
    }

    square.addEventListener('click', function () {
      // 长按已经插过旗了：这次 click 忽略（触屏长按后浏览器还会补一次 click）
      if (longPressed) {
        longPressed = false
        return
      }
      tap(square)
    })

    // 桌面右键插旗。触屏长按系统也会补一个 contextmenu——那时旗已经插好了，
    // 再 toggle 一次等于白插，所以刚摸过屏就跳过。
    square.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      if (Date.now() - lastTouchAt < 800) return
      addFlag(square)
    })

    // 触屏长按插旗（400ms）
    square.addEventListener('touchstart', function (e) {
      if (e.touches.length > 1) return
      lastTouchAt = Date.now()
      longPressed = false
      moved = false
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      square.classList.add('pressing')
      clearTimeout(pressTimer)
      pressTimer = setTimeout(function () {
        pressTimer = null
        if (moved || isGameOver) return
        longPressed = true
        square.classList.remove('pressing')
        addFlag(square)
        buzz()
      }, 400)
    }, { passive: true })

    // 手指轻微抖动（< 12px）不取消长按：以前任何 touchmove 都取消，长按很难成功
    square.addEventListener('touchmove', function (e) {
      if (moved || !pressTimer) return
      const t = e.touches[0]
      if (!t) return
      if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) {
        moved = true
        cancelPress()
      }
    }, { passive: true })

    square.addEventListener('touchend', function () {
      lastTouchAt = Date.now()
      cancelPress()
    })
    square.addEventListener('touchcancel', function () {
      cancelPress()
      // 长按被系统吞掉时不会再来 click：把标记清掉，免得吞掉下一次点击
      longPressed = false
    })
  }

  // 长按插旗时轻震一下（有的 WebView 不支持，失败就算了）
  function buzz() {
    try {
      if (navigator.vibrate) navigator.vibrate(12)
    } catch (e) {}
  }

  // 一次点击：标记模式下插旗，否则翻开；双击已经翻开的格子 = 智能展开
  function tap(square) {
    const now = Date.now()
    const id = Number(square.id)
    const wasOpen = square.classList.contains('checked')

    if (id === lastTapId && now - lastTapAt < 350 && lastTapWasOpen) {
      lastTapId = -1
      chord(square)
      return
    }

    lastTapId = id
    lastTapAt = now
    lastTapWasOpen = wasOpen && !flagMode

    if (flagMode) {
      addFlag(square)
    } else {
      reveal(square)
    }
  }

  // 智能展开：已翻开的数字格周围旗数正好等于数字，就把其余邻格全翻开。
  // 旗数不对时闪一下提示，不替用户猜。
  function chord(square) {
    if (isGameOver || !square.classList.contains('checked')) return
    const total = Number(square.getAttribute('data') || 0)
    if (!total) return

    const around = neighbours(Number(square.id))
    let marked = 0
    around.forEach(function (j) {
      if (squares[j].classList.contains('flag')) marked++
    })

    if (marked !== total) {
      square.classList.add('warn')
      setTimeout(function () {
        square.classList.remove('warn')
      }, 260)
      return
    }

    around.forEach(function (j) {
      if (!squares[j].classList.contains('flag')) reveal(squares[j])
    })
  }

  function addFlag(square) {
    if (isGameOver) return
    if (square.classList.contains('checked')) return
    if (!square.classList.contains('flag')) {
      if (flags >= bombAmount) return
      square.classList.add('flag')
      square.textContent = '🚩'
      flags++
    } else {
      square.classList.remove('flag')
      square.textContent = ''
      flags--
    }
    renderStatus()
    checkForWin()
  }

  // 上游的 click()：翻开一格；空白格递归展开
  function reveal(square) {
    if (isGameOver) return
    if (square.classList.contains('checked') || square.classList.contains('flag')) return
    if (!started) startTimer()

    if (square.classList.contains('bomb')) {
      gameOver(square)
      return
    }

    const total = Number(square.getAttribute('data'))
    square.classList.add('checked')
    if (total > 0) {
      square.classList.add('n' + total)
      square.textContent = total
    } else {
      checkSquare(square, square.id)
    }
    // 翻开也可能是最后一步（尤其是双击智能展开清完场）
    checkForWin()
  }

  // 上游的 checkSquare()：空白格向 8 个方向递归展开（保留 10ms 的逐格展开观感）
  function checkSquare(square, currentId) {
    setTimeout(() => {
      neighbours(Number(currentId)).forEach(function (j) {
        reveal(squares[j])
      })
    }, 10)
  }

  function gameOver(square) {
    isGameOver = true
    stopTimer()
    square.classList.add('boom')
    result.textContent = '💥 踩雷了，重来一局吧'

    // 把所有雷亮出来（上游同款）
    squares.forEach(function (s) {
      if (s.classList.contains('bomb')) {
        s.textContent = '💣'
        s.classList.remove('bomb')
        s.classList.add('checked')
      }
    })
    renderStatus()
  }

  function checkForWin() {
    if (isGameOver) return
    // 上游的判法：旗子插满所有雷
    let flagMatches = 0
    for (let i = 0; i < squares.length; i++) {
      if (squares[i].classList.contains('flag') && squares[i].classList.contains('bomb')) {
        flagMatches++
      }
    }
    // 另外：把所有不是雷的格子都翻开也算赢（不然清完场还得靠插旗收尾）
    const clearedAll = squares.every(function (s) {
      return s.classList.contains('bomb') || s.classList.contains('checked')
    })

    if (flagMatches === bombAmount || clearedAll) {
      isGameOver = true
      stopTimer()
      result.textContent = '🎉 全部清完，用时 ' + seconds + ' 秒'
      renderStatus()
    }
  }

  // ---- 状态栏 ----

  function renderStatus() {
    flagsLeft.textContent = bombAmount - flags
    timeEl.textContent = seconds
    flagButton.classList.toggle('on', flagMode)
    flagButton.textContent = flagMode ? '🚩 标记中' : '🚩 标记'
  }

  function startTimer() {
    started = true
    timerId = setInterval(function () {
      seconds++
      timeEl.textContent = seconds
    }, 1000)
  }

  function stopTimer() {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  flagButton.addEventListener('click', function () {
    flagMode = !flagMode
    renderStatus()
  })

  restartButton.addEventListener('click', function () {
    flagMode = false
    createBoard()
  })

  createBoard()
})
