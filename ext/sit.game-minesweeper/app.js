// 改编自 kubowania/minesweeper（MIT，Copyright (c) 2020 Ania Kubow）
// 上游：https://github.com/kubowania/minesweeper —— master @ a88b0eb0f9da16836dd551ff8cee0a2bdaffef7c
// 改动清单见同目录 NOTICE.md。主要三处：
//   1. 邻格统计与翻开（flood fill）改成按行列算，修掉上游写死的 9/10/11/88/89/90/98 带来的边界数错；
//   2. 触屏：加「🚩 标记」模式 + 长按插旗（触屏没有右键），桌面右键照旧；
//   3. 加计时器、重来按钮、中文文案；顺带把「把所有非雷格子翻开」也算赢（上游只在插满旗时判赢）。
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

    square.addEventListener('click', function () {
      // 长按已经插过旗了：这次 click 忽略（触屏长按后浏览器还会补一次 click）
      if (longPressed) {
        longPressed = false
        return
      }
      tap(square)
    })

    // 桌面右键插旗
    square.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      addFlag(square)
    })

    // 触屏长按插旗（450ms）
    square.addEventListener('touchstart', function () {
      longPressed = false
      pressTimer = setTimeout(function () {
        longPressed = true
        addFlag(square)
      }, 450)
    }, { passive: true })
    square.addEventListener('touchend', function () {
      clearTimeout(pressTimer)
    })
    square.addEventListener('touchmove', function () {
      clearTimeout(pressTimer)
    })
    square.addEventListener('touchcancel', function () {
      clearTimeout(pressTimer)
    })
  }

  // 一次点击：标记模式下插旗，否则翻开
  function tap(square) {
    if (flagMode) {
      addFlag(square)
    } else {
      reveal(square)
    }
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
      return
    }
    checkSquare(square, square.id)
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
