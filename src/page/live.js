/**
 * The page's behaviour, all of it.
 *
 * Two jobs: open a Seat, and keep the figures current. It writes figures into
 * elements that already exist and never re-renders a list, so nothing moves under
 * the cursor. When the shape of the page itself changes, it reloads rather than
 * patching, because writing a number into an element that is not there is how a
 * live page starts lying quietly.
 */
(function () {
  var every = 5000;
  var structure = document.body.getAttribute("data-structure");
  var stopped = false;

  document.querySelectorAll(".seat-line").forEach(function (line) {
    line.addEventListener("click", function () {
      line.parentElement.classList.toggle("open");
    });
  });

  function apply(values) {
    values.forEach(function (one) {
      var node = document.querySelector('[data-live="' + CSS.escape(one.key) + '"]');
      if (node === null) return;
      if (one.text !== undefined && node.textContent !== one.text) node.textContent = one.text;
      if (one.html !== undefined && node.innerHTML !== one.html) node.innerHTML = one.html;
      if (one.width !== undefined) {
        var fill = node.querySelector("i") || node;
        fill.style.width = one.width + "%";
      }
      if (one.level !== undefined) {
        node.classList.remove("warn", "full");
        if (one.level !== "plain") node.classList.add(one.level);
      }
    });
  }

  function drawLog(lines) {
    var pane = document.querySelector("[data-log]");
    if (pane === null) return;
    var wanted = lines
      .map(function (one) {
        return (
          '<div class="l"><span class="ts">' + one.time + '</span><span class="ev ' + one.tone + '">' + one.event + "</span><span>" + one.text + "</span></div>"
        );
      })
      .join("");
    if (pane.innerHTML !== wanted) {
      pane.innerHTML = wanted;
      pane.scrollTop = pane.scrollHeight;
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    var box = document.querySelector("[data-every]");
    var asked = new URLSearchParams(location.search);
    if (box !== null && box.checked) asked.set("every", "1");
    return fetch("/state?" + asked.toString(), { headers: { accept: "application/json" } })
      .then(function (answer) {
        return answer.json();
      })
      .then(function (answer) {
        if (answer.structure !== structure) {
          stopped = true;
          location.reload();
          return;
        }
        apply(answer.live);
        drawLog(answer.log);
      })
      .catch(function () {
        /* The relay is restarting, most likely. The next tick tries again. */
      });
  }

  function act(body) {
    return fetch("/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function () {
      location.reload();
    });
  }

  document.querySelectorAll("[data-use]").forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      act({ use: button.getAttribute("data-use") });
    });
  });

  document.querySelectorAll("[data-open]").forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      act({ open: button.getAttribute("data-open") });
    });
  });

  document.querySelectorAll("[data-mode]").forEach(function (button) {
    button.addEventListener("click", function () {
      act({ mode: button.getAttribute("data-mode") });
    });
  });

  var everyBox = document.querySelector("[data-every]");
  if (everyBox !== null) everyBox.addEventListener("change", function () { refresh(); });

  document.querySelectorAll("[data-period]").forEach(function (button) {
    button.addEventListener("click", function () {
      var here = new URL(location.href);
      here.searchParams.set("period", button.getAttribute("data-period"));
      location.href = here.toString();
    });
  });

  var refreshButton = document.querySelector("[data-refresh]");
  if (refreshButton !== null) refreshButton.addEventListener("click", function () { refresh(); });

  setInterval(refresh, every);
})();
