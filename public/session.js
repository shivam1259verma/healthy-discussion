// Session bar: shows sign-in state, handles sign-out and expiry. Holds no secrets.
(function () {
  var bar = document.getElementById('sessionBar');
  var expired = document.getElementById('sessionExpired');
  var relaunch = document.getElementById('relaunchLink');

  function showExpired(launchUrl) {
    bar.hidden = true;
    expired.hidden = false;
    if (launchUrl) relaunch.href = launchUrl;
    else relaunch.removeAttribute('href');
  }

  function check() {
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) return r.json().then(function (b) { showExpired(b.launchUrl); });
        if (!r.ok) return; // temporary failure: keep the page, try again next tick
        bar.hidden = false;
        expired.hidden = true;
      })
      .catch(function () {});
  }

  document.getElementById('btnSignOut').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { window.location.reload(); })
      .catch(function () { window.location.reload(); });
  });

  check();
  setInterval(check, 60 * 1000);
})();
