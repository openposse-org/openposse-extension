// Grants the microphone once, for this extension's origin.
//
// It has to happen in a real tab. An offscreen document has no UI to show a prompt in, and a
// side panel is documented as failing with "NotAllowedError: Permission dismissed" on macOS —
// the request succeeds only where the browser can actually ask.

const out = document.getElementById('out');
const say = (text) => { out.textContent = text; };

document.getElementById('grant').addEventListener('click', async () => {
  say('asking…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Released immediately. The *grant* is what persists; holding the device would keep the
    // orange indicator lit for no reason.
    for (const track of stream.getTracks()) track.stop();

    const state = (await navigator.permissions.query({ name: 'microphone' })).state;
    say(`granted — permissions.query says "${state}"\n\nClose this tab and click the toolbar button.`);
  } catch (error) {
    say(`FAILED: ${error.name} — ${error.message}`);
  }
});

// Also report where we start, so a second visit is not confusing.
navigator.permissions.query({ name: 'microphone' })
  .then(({ state }) => { if (state === 'granted') say('already granted'); })
  .catch(() => { /* older Chrome without the query — the button still works */ });
