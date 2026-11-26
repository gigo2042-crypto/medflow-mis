/* MedFlow: встраивание онлайн-записи на сайт клиники.
 *   <div id="medflow-booking"></div>
 *   <script src="https://<адрес МИС>/embed.js" data-target="medflow-booking" defer></script>
 * Домен сайта должен быть в WIDGET_ALLOWED_ORIGINS на сервере МИС (иначе браузер не покажет фрейм). */
(function () {
  var script = document.currentScript
  if (!script) return
  var base = new URL(script.src).origin
  var targetId = script.getAttribute('data-target') || 'medflow-booking'
  var target = document.getElementById(targetId)
  if (!target) {
    target = document.createElement('div')
    target.id = targetId
    script.parentNode.insertBefore(target, script)
  }
  var frame = document.createElement('iframe')
  frame.src = base + '/book'
  frame.title = 'Онлайн-запись'
  frame.loading = 'lazy'
  frame.setAttribute('allow', 'clipboard-write')
  frame.style.cssText = 'width:100%;max-width:480px;min-height:560px;border:0;display:block'
  target.appendChild(frame)
  window.addEventListener('message', function (e) {
    if (e.origin !== base || e.source !== frame.contentWindow) return
    var d = e.data
    if (d && d.type === 'medflow:height' && typeof d.height === 'number' && d.height > 0 && d.height < 5000) {
      frame.style.height = Math.max(560, Math.ceil(d.height)) + 'px'
    }
  })
})()
