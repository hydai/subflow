// Subflow background service worker.
//
// Today this is the minimum needed for §6.8 entry point (a): when the
// user clicks the Subflow toolbar icon, open the options page. The
// click event fires here (rather than opening a popup) only because
// the manifest action has no `default_popup`. Subsequent issues
// (#4-#7, #15, #16, #18) add subtitle fetching, workflow execution,
// and error coverage on top of this entry.

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

export {};
