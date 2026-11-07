/**
 * Desktop app — native OS notifications behind the `notifications` setting.
 *
 * One helper for every notification the app shows (the first-close tray
 * notice, "Update ready", pet imports). The pet's speech bubbles are not
 * OS notifications and have their own toggles. Without `getSettings` (the
 * pets runtime failed to start) notifications stay on.
 */

/**
 * @typedef {{ title: string, body: string, silent?: boolean, onClick?: () => void }} Notice
 * @typedef {'shown' | 'off' | 'unsupported'} NoticeResult
 */

/**
 * @param {{
 *   Notification: any,
 *   getSettings?: () => { notifications?: boolean }
 * }} deps
 * @returns {(notice: Notice) => NoticeResult}
 */
export function createNotifier({ Notification, getSettings }) {
  return function notify({ title, body, silent, onClick }) {
    if (getSettings && getSettings().notifications === false) return 'off';
    if (!Notification.isSupported()) return 'unsupported';
    const notification = new Notification(
      silent === undefined ? { title, body } : { title, body, silent }
    );
    if (onClick) notification.on('click', onClick);
    notification.show();
    return 'shown';
  };
}
