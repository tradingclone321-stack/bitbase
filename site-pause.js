/* ============================================================================
   SITE PAUSE SWITCH
   ----------------------------------------------------------------------------
   While SITE_PAUSED is true, every page of this site — including the admin
   panel — instantly redirects to paused.html. Visitors never see the app.

   TO PUT THE SITE BACK ONLINE
     Change the line below to:      var SITE_PAUSED = false;
     then upload this one file. Nothing else needs to change.

   TO PAUSE IT AGAIN
     Set it back to true and upload.

   TO REMOVE THE PAUSE COMPLETELY
     Delete paused.html and this file, and remove the
     <script src="site-pause.js"></script> line from the page <head>s.
   ========================================================================== */
(function () {
  var SITE_PAUSED = false;
  if (!SITE_PAUSED) return;

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (page === 'paused.html') return;

  // Keep the screen black while the redirect happens so no app content flashes.
  try { document.documentElement.style.background = '#000'; } catch (e) {}

  location.replace('paused.html');
})();
