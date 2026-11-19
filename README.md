<img src="icon.svg" width="96" alt="">

# Promptline

A Tampermonkey userscript for ChatGPT.

For daily ChatGPT image work: paste a list of prompts, and `chatgpt-prompt-queue.user.js` sends them one at a time, saves each image as it finishes, waits out usage limits, and lets you tidy the sidebar in bulk.

**Install:** with Tampermonkey installed, open [the raw script](https://raw.githubusercontent.com/Adztrz/promptline/main/chatgpt-prompt-queue.user.js): Tampermonkey offers to install it and keeps it up to date from here. Or by hand: in Tampermonkey's dashboard, click **+**, replace the editor's contents with the file, save, then reload ChatGPT (a copy pasted by hand doesn't update itself). The first download and the first notification may each ask for permission once.

## Queue

Click the Promptline button at the bottom right (or press **Alt+Q**), paste one prompt per line, click **Load prompts**, then **Start** (the same button pauses and resumes). Each prompt gets its own card showing whether it's queued, next, generating, sent or saved; click a card's text to see the whole prompt. Don't type in the chat box while it runs, and keep the tab open.

- **Downloads:** each finished image is saved straight to your downloads folder, named by queue number and prompt, such as `cozy-007-a-small-wooden-cabin-beside-a.png`. Set the `cozy-` part under **Settings → File name prefix**. ChatGPT makes its images as WebP; **Save as PNG** (on by default) converts each one, or turn it off to keep the WebP.
- **Limits:** when ChatGPT says you hit a limit, the queue reads when it resets, counts down, and sends that prompt again. Turn this off in Settings to pause instead.
- It also pauses on a reply over 8 minutes, a page reload, or if it can't send. **More → Check page** shows what the script can find, for when ChatGPT changes its page. **More → Clear queue** can be undone for 10 seconds.

## Today

The line under the header counts the prompts sent and images made today, queued or not, and when a limit will reset.

## Select chats

Click **Select chats** (or press **Alt+X**). Clicking a chat in the sidebar now ticks it instead of opening it; **Shift**-click ticks a range. **Select matching** ticks every loaded chat whose title contains your text, and **All** ticks every loaded chat (scroll the sidebar to load older ones). Then:

- **Archive** moves them to Settings → Archived chats, where they can be restored.
- **Delete** removes them for good, after asking first.

Reload the page afterwards to refresh the sidebar. **Esc** or **Done** leaves selection. This uses the same private endpoint as ChatGPT's own menu, so it may need an update if ChatGPT changes it.

## Library

Under **Library** (or **Alt+L**), save prompts and style lines you reuse. **Insert** adds one to the chat box; **Add to queue** adds its lines as queue prompts. Type to search, and press **Enter** to insert the first match.

## Notifications

A desktop notification arrives when the queue finishes, pauses, or waits on a limit. Turn them off, or send a test one, under Settings.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Alt+Q | Open or close the panel |
| Alt+S | Start or pause the queue |
| Alt+X | Select chats in the sidebar |
| Alt+L | Prompt library |
| Esc | Leave chat selection |
