document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL('dashboard.html') },
    () => window.close()
  );
});