/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function browserWindowsCount() {
  let count = 0;
  let e = Services.wm.getEnumerator("navigator:browser");
  while (e.hasMoreElements()) {
    if (!e.getNext().closed)
      ++count;
  }
  return count;
}

function test() {
  /** Test for Bug 461634, ported by Bug 524345 **/
  is(browserWindowsCount(), 1, "Only one browser window should be open initially");

  waitForExplicitFinish();

  const REMEMBER = Date.now(), FORGET = Math.random();
  let test_state = { windows: [{ "tabs": [{ "entries": [] }], _closedTabs: [
    { state: { entries: [{ url: "http://www.example.net/" }] }, title: FORGET },
    { state: { entries: [{ url: "http://www.example.net/" }] }, title: REMEMBER },
    { state: { entries: [{ url: "http://www.example.net/" }] }, title: FORGET },
    { state: { entries: [{ url: "http://www.example.net/" }] }, title: REMEMBER },
  ] }] };
  let remember_count = 2;

  function countByTitle(aClosedTabList, aTitle)
    aClosedTabList.filter(function(aData) aData.title == aTitle).length;

  function testForError(aFunction) {
    try {
      aFunction();
      return false;
    }
    catch (ex) {
      return ex.name == "NS_ERROR_ILLEGAL_VALUE";
    }
  }

  // open a window and add the above closed tab list
  let newWin = openDialog(location, "", "chrome,all,dialog=no");
  newWin.addEventListener("load", function loadListener(aEvent) {
    newWin.removeEventListener("load", loadListener, false);

    Services.prefs.setIntPref("browser.sessionstore.max_tabs_undo",
                              test_state.windows[0]._closedTabs.length);
    ss.setWindowState(newWin, JSON.stringify(test_state), true);

    let closedTabs = JSON.parse(ss.getClosedTabData(newWin));
    is(closedTabs.length, test_state.windows[0]._closedTabs.length,
       "Closed tab list has the expected length");
    is(countByTitle(closedTabs, FORGET),
       test_state.windows[0]._closedTabs.length - remember_count,
       "The correct amout of tabs are to be forgotten");
    is(countByTitle(closedTabs, REMEMBER), remember_count,
       "Everything is set up.");

    // all of the following calls with illegal arguments should throw NS_ERROR_ILLEGAL_VALUE
    ok(testForError(function() ss.forgetClosedTab({}, 0)),
       "Invalid window for forgetClosedTab throws");
    ok(testForError(function() ss.forgetClosedTab(newWin, -1)),
       "Invalid tab for forgetClosedTab throws");
    ok(testForError(function() ss.forgetClosedTab(newWin, test_state.windows[0]._closedTabs.length + 1)),
       "Invalid tab for forgetClosedTab throws");

    // Remove third tab, then first tab
    ss.forgetClosedTab(newWin, 2);
    ss.forgetClosedTab(newWin, null);

    closedTabs = JSON.parse(ss.getClosedTabData(newWin));
    is(closedTabs.length, remember_count,
       "The correct amout of tabs was removed");
    is(countByTitle(closedTabs, FORGET), 0,
       "All tabs specifically forgotten were indeed removed");
    is(countByTitle(closedTabs, REMEMBER), remember_count,
       "... and tabs not specifically forgetten weren't.");

    // clean up
    newWin.close();
    is(browserWindowsCount(), 1, "Only one browser window should be open eventually");
    Services.prefs.clearUserPref("browser.sessionstore.max_tabs_undo");
    finish();
  }, false);
}
