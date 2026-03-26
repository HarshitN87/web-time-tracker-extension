document.getElementById('open-dashboard').addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
});
