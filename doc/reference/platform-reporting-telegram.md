---
type: reference
title: "Platform reporting: Telegram"
description: "How to report channels, posts, users and bots on Telegram (in-app reasons, abuse@ and stopCA@ email routes, the EU form), Telegram's documented posture, the forwarded-from-bot guidance, the Bot Developer Terms the project relies on, and the points the bot's instructions make."
status: active
tags: [reference, platform, telegram, reporting, bots]
timestamp: 2026-10-28T00:00:00Z
---

# Platform reporting: Telegram

Telegram is both the bot's home and a target platform: the owner's own
abuse cases are Telegram channels fed by throwaway public bots. This page
covers reporting channels, posts, users and bots on Telegram; the Bot API
facts the bot itself relies on are in
[telegram-bot-api-notes.md](./telegram-bot-api-notes.md). It was compiled
on 2026-10-28 from the research note of that date. Every URL below was
fetched or rendered on 2026-10-28 unless it is tagged [S] or marked "not
fetched". Policy text is quoted exactly as the research note quotes it.
Several Telegram pages were served to the researcher in German only; the
German is quoted verbatim with the researcher's translation, labelled. The
project's own routing decisions are in
[report-categories-and-routing.md](../product/report-categories-and-routing.md).

How to read the tags: [H] raw HTTP fetch, text read verbatim; [R] public
page rendered in a headless browser without login, text read verbatim;
[W] read only through a summarising fetch tool, needs confirmation; [P] PDF
converted to text; [G] source code fetched from GitHub; [S] seen only in a
search result, not read; [INF] the researcher's inference, not a platform
statement. Section-specific tags: [DOC] official Telegram documentation,
[CODE] official open-source client or server code fetched from GitHub on
2026-10-28, [SEC] secondary source.

## How to report

### In-app reporting: messages, channels, groups, users and bots

- FAQ [H] https://telegram.org/faq, entry "There's illegal content on
  Telegram. How do I take it down?": "All Telegram apps have 'Report'
  buttons that let you flag illegal content for our moderators — in just a
  few taps." and "On Telegram for Android, tap the message and select Report
  from the menu. On iOS, press and hold the message. On Telegram Desktop,
  Web or Telegram for macOS, right-click the message and select Report.
  Then choose an appropriate reason."
- Safety page [H] https://telegram.org/safety adds "Choose a reason for
  your report and provide a comment if needed." and "You can also report
  search terms that may be used to find illegal content in your country
  through the official @SearchReport bot." (t.me/SearchReport, "Search
  Report Bot", "Report problematic search terms.").
- Users, groups, channels and bots are all "peers" that can be reported.
  [DOC] https://core.telegram.org/method/account.reportPeer: "Report a peer
  for violation of telegram's Terms of Service" (parameters: the peer, a
  reason, a comment). Telegram Desktop's dialog titles are "Report
  channel", "Report Group", "Report bot" and "Report message" [CODE]. The
  user-profile report path was not read; [INF] it uses the same reason
  list.
- Static reasons in the Desktop and Android clients [CODE]: "Spam", "Fake
  Account", "Violence", "Child Abuse", "Pornography", "Copyright", "Illegal
  Drugs", "Personal Details", "Other", plus an optional comment. [DOC]
  https://core.telegram.org/type/ReportReason lists the same set for
  account.reportPeer: `inputReportReasonChildAbuse` "Report for child
  abuse", `inputReportReasonPersonalDetails` "Report for divulgation of
  personal details", `inputReportReasonFake` "Report for impersonation".
  There is no harassment or bullying reason in that list.
- The live menu is server-driven. [DOC] https://core.telegram.org/type/ReportResult:
  `reportResultChooseOption`, "The user must choose one of the following
  options, and then messages.report must be re-invoked", with options
  "rendered as menu entries"; `reportResultAddComment` (comment optional
  or mandatory). Both clients react to the server error
  `MESSAGE_ID_REQUIRED` by asking the reporter to "Select messages" [CODE],
  so a channel-level report can require specific posts as evidence. [INF]
  Reporting the channel and reporting the post are therefore not exclusive;
  a channel report may ask for the posts anyway.
- Confirmation texts [CODE]: Desktop "Thank you! Your report will be
  reviewed by our team."; Android "Telegram moderators will study your
  report.".

### Email routes

- FAQ [H]: "You can also use our automated takedown email address
  abuse@telegram.org. If you're sending an email takedown request, please
  make sure to include links (like t.me/... or @...) to the content on
  Telegram which you think needs attention from our moderators."
- Safety page [H]: Telegram "processes thousands of reports on CSAM from
  global third-party organizations via automated takedown addresses:"
  abuse@telegram.org and stopCA@telegram.org (listed as two links).
- Appeals for banned bots and channels also go to abuse@telegram.org
  (FAQ).
- EU form [H] https://telegram.org/dsa-report ("Report Illegal Content
  under the EU Digital Services Act"; the page is a button behind a
  Cloudflare Turnstile challenge, so the fields were not inspected). The EU
  guidance https://telegram.org/tos/eu-dsa [H] (served in German) asks
  reporters for name, contact information and "einer klaren und
  überzeugenden Erklärung, warum der betreffende Inhalt illegal ist"
  (researcher's translation: a clear and convincing explanation why the
  content is illegal). Contact bot: @EURegulation ("EU Regulation Bot",
  t.me/EURegulation).

### Child abuse

Project rule first: suspected child sexual abuse material is never
broadcast (critical invariant 7). The admin files one in-app report and
emails stopCA@telegram.org from the routing card, plus one hotline report;
see [csam-hotlines.md](./csam-hotlines.md) and the
[admin review runbook](../guides/admin-review-runbook.md). Non-sexual child
abuse goes through the normal flow with the same in-app reason.

- Client reason "Child Abuse" [CODE]; API reason "Report for child abuse"
  [DOC]. Email: abuse@telegram.org or stopCA@telegram.org.
- Public channel https://t.me/stopCA [H] (og:title "Stop Child Abuse";
  og:description "This channel publishes daily updates on banned CA-related
  content. Report via the in-app button or by emailing stopCA@telegram.org").
  @stopCA is a channel, not a bot; the project brief's earlier mention of a
  "@StopCA bot" is not supported.
- Safety page [H]: "Telegram enforces a zero-tolerance policy for Child
  Sexual Abuse Materials (CSAM). Since 2018, public images are
  automatically checked against a hash database of CSAM banned by our
  moderators over the past decade. In 2024, we expanded this database with
  hashes from organizations like the Internet Watch Foundation." Its table
  "CSAM Blocked via NGO reports" names Stichting Offlimits, the Canadian
  Centre for Child Protection, NCMEC and the IWF as "the top four NGOs that
  submitted takedown reports to Telegram in 2025".
- IWF news [R]
  https://www.iwf.org.uk/news-media/news/telegram-joins-iwf-in-child-sexual-abuse-imagery-crackdown/
  (Wed 4 Dec 2024): "the IWF will report directly into Telegram when child
  sexual abuse imagery is detected and work with them to remove it
  swiftly."

### Personal details (doxxing)

- Client reason "Personal Details" [CODE]; API reason "Report for
  divulgation of personal details" [DOC].
- EU guidance (German) lists among illegal activities "die Weitergabe von
  persönlichen Daten anderer, um sie einzuschüchtern oder zu schikanieren
  (Doxing)" (researcher's translation: sharing others' personal data to
  intimidate or harass them (doxxing)).

### Harassment and bullying

- No dedicated reason exists in the static client lists [CODE].
- The Terms of Service (German page) prohibit "Unsere Dienste zu nutzen,
  um Spam zu senden oder Nutzer zu belästigen." (researcher's translation:
  using our services to send spam or harass users).
- [INF] A reporter uses the closest option the live menu offers, or
  "Other" with a short comment; the live option tree is unverified (see
  Unverified).

### Impersonation

- Client reason "Fake Account" [CODE]; API reason "Report for
  impersonation" [DOC].
- FAQ [H]: "If a scammer is pretending to be you, contact @NoToScam"
  (t.me/notoscam, "Report Impersonation").
- EU guidance: accounts, bots, groups and channels that impersonate or
  defraud can be labelled FAKE or SCAM.

## Policy pages

All [H] unless noted:

- Terms of Service https://telegram.org/tos (the researcher's IP was
  redirected to https://telegram.org/tos/de, German text). The prohibitions
  for public platforms, quoted in German with the English sense coming only
  from the summarising tool [W]: spam and harassment; "Förderung von Gewalt
  auf öffentlich zugänglichen Telegram-Kanälen, Bots usw."; "Veröffentlichung
  illegaler pornografischer Inhalte auf öffentlich zugänglichen
  Telegram-Kanälen, Bots, usw."; activities illegal in most countries,
  including child abuse.
- EU DSA user guidance https://telegram.org/tos/eu-dsa (German only from
  the researcher's IP): "Illegale sexuelle Inhalte. Wir erlauben niemals
  Material über sexuellen Kindesmissbrauch, Bestiality und die
  nicht-einvernehmliche Veröffentlichung von sexuellem Material." Also
  "Wir werden immer die am wenigsten restriktiven Maßnahmen bevorzugen" and
  "bedürfen alle kritischen Einschränkungen der Genehmigung eines
  menschlichen Moderators." (Translation added here, not from the research
  note: illegal sexual content; material of child sexual abuse, bestiality
  and non-consensual publication of sexual material is never allowed; the
  least restrictive measures are always preferred; all critical
  restrictions require a human moderator's approval.)
- FAQ takedown scope: "Public content on Telegram, such as user-uploaded
  stickers sets, channels, and bots by third-party developers, is not part
  of the core Telegram UI. Whenever we receive a report regarding
  potentially illegal public content, we perform the necessary legal checks
  and take it down when deemed appropriate." In the copyright answer:
  "Private groups and chats on Telegram are private amongst their
  participants. We do not process any requests related to them." [SEC]
  TechCrunch, 2024-09-06, read through
  https://finance.yahoo.com/news/telegram-quietly-enables-users-report-023256551.html
  [W]: Telegram updated the FAQ "to explicitly allow users to report
  private chats to its moderators".
- Safety overview https://telegram.org/safety; Bot Developer Terms
  https://telegram.org/tos/bot-developers (quoted below); Privacy Policy
  https://telegram.org/privacy (German from the researcher's IP; section
  5.3: "können unsere Moderatoren Nachrichten überprüfen, die ihnen von den
  Empfängern gemeldet und zugesendet wurden", researcher's translation:
  moderators may review messages that recipients reported and sent to
  them).

## Posture on volume, duplicates and false reports

- Deduplication, identical text and report counts: not documented anywhere
  read.
- Reports do have automatic effects on the reported account (FAQ [H],
  entries "Can't send messages to non-contacts" and "What is a Frozen
  Account?"): "When users report unwanted messages from a Telegram
  account, we apply a limit: Reported accounts can only send messages to
  people who have their number saved as a contact." and "If your account
  has been restricted because of reports from other users, your account is
  frozen."; the appeal is "directly from the app".
  https://telegram.org/faq_spam [H]: "When users press the 'Report spam'
  button in a chat, they forward these messages to our team of moderators
  for review." The thresholds are undocumented.
- Reporter sanctions appear only in the EU DSA guidance (German): "Wir
  müssen deine Meldung unter Umständen zurückweisen, wenn die von dir
  gemachten Angaben nicht ausreichen, um sie zu stützen, und können die
  Bearbeitung deiner Hinweise und Beschwerden aussetzen, wenn du wiederholt
  offensichtlich unbegründete, betrügerische oder irreführende Meldungen
  einreichst." Researcher's translation: we may have to reject your report
  if your details are insufficient to support it, and may suspend
  processing of your notices and complaints if you repeatedly submit
  manifestly unfounded, fraudulent or misleading reports. The English
  original ("We may have to dismiss your report if the information
  provided by you is insufficient to support it and may suspend the
  processing of your notices and complaints if you repeatedly submit
  manifestly unfounded, fraudulent or misleading reports.") is known only
  from a search result [S] for https://telegram.org/tos/eu-dsa?setln=en.
  Nothing of the kind is stated for in-app reports.
- NGO routes: no programme, application process or eligibility criteria
  are documented. What is documented: abuse@telegram.org and
  stopCA@telegram.org as "automated takedown addresses" used by "global
  third-party organizations", the CSAM hash database expanded "with hashes
  from organizations like the Internet Watch Foundation", and the IWF
  direct-report arrangement. See
  [trusted-flagger-programmes.md](./trusted-flagger-programmes.md).
- [INF] One in-app report per member of the channel and of the post, plus
  the NGO's own email with the links, is the documented pattern; nothing
  documented says that more reports act faster, and reports visibly
  trigger automatic limits on the reported account, which argues for
  genuine, specific reports rather than volume.

## Reporting a channel post that is a forward of a bot's message

Added at the owner's request (research note section 5A). The owner's
observation is that reporting such a post seems to be redirected to the
bot rather than the channel. Short answer: nothing readable (FAQ, Safety
page, EU guidance, Bot API, MTProto API docs, client code) says that a
report on a forwarded channel post is redirected to the forward origin.
The documented API and the client code show the opposite: the report is
addressed to the chat in which the post is displayed (the channel) plus
that post's message id; the forward header is not a parameter. What the
moderators then do (act on the channel, the origin bot, or both) is
server-side and undocumented. So "bug or documented behaviour?" cannot be
settled from public sources; the redirect claim is recorded as unverified
moderator behaviour.

### What is reported when a channel message is reported

- [DOC] https://core.telegram.org/method/messages.report: "Report a message
  in a chat for violation of telegram's Terms of Service"; TL signature
  `messages.report#fc78af9b peer:InputPeer id:Vector<int> option:bytes message:string = ReportResult`;
  parameters peer ("Peer"), id ("IDs of messages to report"), option
  ("Menu option, intially empty" (sic)), message ("Comment for report
  moderation"); "Only users can use this method" (bots cannot file or
  receive reports via this method).
- [DOC] https://core.telegram.org/constructor/message.md: `peer_id` is
  "Peer ID, the chat where this message was sent"; `fwd_from` is "Info
  about forwarded messages". `messages.report` has no argument for
  `fwd_from`. Bot API equivalents (https://core.telegram.org/bots/api#message):
  `chat` is "Chat the message belongs to"; `forward_origin` is
  "Information about the original message for forwarded messages".
- [CODE] Telegram Desktop (telegramdesktop/tdesktop, branch dev),
  `Telegram/SourceFiles/history/view/history_view_context_menu.cpp`,
  `AddReportAction`: `const auto peer = item->history()->peer;` then
  `ShowReportMessageBox(controller->uiShow(), peer, ids, {});` with ids
  being the item's own id (or the whole album). Nothing reads the forward
  header. `HistoryItem::suggestReport()` shows Report for non-outgoing,
  non-service messages in channels and supergroups and in chats with
  bots. Telegram Android (DrKLO/Telegram, master) `ChatActivity.java`
  option `OPTION_REPORT_CHAT` calls
  `ReportBottomSheet.openMessage(ChatActivity.this, selectedObject)`, which
  sends `TL_messages_report` with `req.peer = getInputPeer(dialogId)` and
  the message id(s). iOS (TelegramMessenger/Telegram-iOS, master): the
  engine call `reportPeerMessages(messageIds:reason:message:)` takes only
  message ids (each carries its chat); the current iOS report-content path
  was not read.
- [SEC] TechCrunch, 2024-09-06 (via the Yahoo copy above [W]): a Telegram
  spokesperson said users could "always report messages from any group to
  moderators," a mechanism that "acts like forwarding." [DOC] Privacy
  Policy section 5.3 (German): moderators "können ... Nachrichten
  überprüfen, die ihnen von den Empfängern gemeldet und zugesendet wurden".
- [INF] So what is reported is the message as it sits in that channel, a
  copy of which goes to the moderators. Whether the moderators' tooling
  also shows the forward header (it is part of the stored message) and
  acts on the origin bot is unknown.

### Are forwarded messages treated differently?

- [CODE] There is no forward special-case in the Desktop or Android
  message-report path. The only forward-aware report code found is
  Android's special "Replies" system chat (`UserObject.isReplyUser`), which
  blocks or reports the original replier via `fwd_from.from_id`; it does
  not apply to channel posts.
- [DOC] No "report original sender" option is documented in the FAQ, the
  Safety page, the EU guidance, the Bot API or the MTProto pages. A search
  for a matching feature request on bugs.telegram.org found none [S].
- [CODE] The header is tappable: Desktop `HistoryMessageForwarded::create`
  (`history_item_components.cpp`) uses
  `JumpToMessageClickHandler(originalSender, originalId)` for a channel
  origin and `originalSender->openLink()` otherwise (the profile of the
  user or bot). [INF] Mobile clients behave alike; a member can tap
  "Forwarded from <bot>" to reach the bot's profile and report the bot
  there.
- [DOC] The header can be absent: `drop_author` in
  `messages.forwardMessages` ("Whether to forward messages without quoting
  the original author"), Bot API `copyMessage` ("the copied message doesn't
  have a link to the original message"), content protection `noforwards`
  ("cannot be forwarded"), and the user privacy setting "Forwarded
  Messages" (https://telegram.org/blog/unsend-privacy-emoji [H]: forwards
  "will show your display name in plain unlinked text"; applies to user
  accounts). Members then see no bot attribution.

### "via @bot" versus "Forwarded from"

- "via @bot" [DOC]: MTProto `via_bot_id` is "ID of the inline bot that
  generated the message"; Bot API `via_bot` is "Bot through which the
  message was sent". It is created when a user picks an inline result; the
  sender stays the user or channel; the client label is "via
  {inline_bot}".
- "Forwarded from" [DOC]: MTProto `messageFwdHeader.from_id` is "The ID of
  the user that originally sent the message" (bots are users);
  `channel_post` is "ID of the channel message that was forwarded"; Bot API
  `forward_origin` types are `user` ("originally sent by a known user";
  `User.is_bot` is true for bots), `hidden_user`, `chat`, `channel`; the
  client labels are "Forwarded from {user}" or "{channel}". It means the
  bot account itself sent the original message into some chat. Both labels
  can co-occur: "Forwarded from {channel} via {inline_bot}" ([CODE]
  lang.strings).
- [INF] "Forwarded from <bot>" shows that the bot sent the media; it does
  not show who uploaded it to the bot, and Telegram documents no field
  exposing that. The Safety page's hash check applies to "public images";
  nothing says whether media relayed through bots is covered.
- [SEC] EU DisinfoLab (Dec 2022,
  https://www.disinfo.eu/wp-content/uploads/2022/12/20221220_TD_Telegram.pdf
  [P]): a table of report categories per client (Child abuse on Android,
  iOS, macOS, Web, Windows; Personal details on all but Windows Desktop at
  that time) and "Users can report content (i.e., specific messages of a
  chat) ... During the process, users can also add a comment."

### Recommended way to report the channel itself

- [CODE] The profile or menu "Report": Desktop `Filler::addReport`
  (`window_peer_menu.cpp`), shown for groups and channels you did not
  create, calls `ShowReportMessageBox(..., peer, {}, {})`. Android strings:
  "Report" (`ReportChat`). The reasons are the static list above.
- [DOC] Email routes: abuse@telegram.org (include "links (like t.me/... or
  @...) to the content"), stopCA@telegram.org (CSAM takedowns by
  third-party organisations), the EU form https://telegram.org/dsa-report.
  No application process for NGOs is documented.
- [INF] Wording the bot can use (not Telegram guidance): (1) open the
  channel, use Report in its menu and pick "Child Abuse" or "Personal
  Details"; (2) also report the specific post (message menu, Report);
  (3) if the post shows "Forwarded from <bot>", tap the header, open the
  bot, Report, "Report bot"; (4) organisations can email abuse@telegram.org
  or stopCA@telegram.org with the t.me/<channel>/<post> link and the bot's
  @username.

## Bot Developer Terms the project relies on

All quotes [H] https://telegram.org/tos/bot-developers (the bot is a
"TPA", a third-party application, in the Terms' wording):

- Section 5.1: "You are responsible for any content uploaded by your TPA,
  including the moderation of user-generated content that is accessible
  via your TPA, and agree that Telegram may also intervene to moderate
  content hosted by your TPA, but is not obligated to do so."
- Section 5.2(e): no "external services or applications that diverge
  significantly from the intended use cases of Bot Platform (e.g., cloud
  storage sites)".
- Section 5.2(f): "Your TPA must not attempt to circumvent or otherwise
  undermine Telegram rate limits and moderation. ... must not operate by
  proxy (i.e., using Bot API credentials supplied by other users) in an
  attempt to circumvent bans or content moderation."
- Section 5.2(i): no uploading or facilitating "personal information or
  media belonging to unconsenting third parties and similar content". This
  clause is the basis of the project's doxxing default (decision Q2 of
  2026-10-28: account link by default, post URL only by an admin's recorded
  opt-in, never for intimate images shared without consent).
- Section 6.3: "Telegram may delete or make inaccessible whole chats,
  messages, media and files sent to and from your TPA at any time."
- Section 5.2 also carries the paragraph on "significant changes pertaining
  to the operational scope" of a bot (quoted in the decision record, not
  in the research note): adding a bulk message kind beyond approved
  reports, retractions and closure outcomes requires informing users with
  an opt-out. See
  [broadcast-consent-policy.md](../product/broadcast-consent-policy.md).
- Telegram documents no "laundering" concept and nothing about bot messages
  being forwarded into channels; the sections above are the closest text.

## What the bot's instructions say

The points below are what a member makes, in their own words, in one
Telegram report. They are the English source for the i18n catalogs (the
Persian copy is written from them later). They apply the decision of
2026-10-28 (Q7): one genuine report per member, no template text to paste,
no promise of removal. On Telegram the target is usually a channel and a
post in it, sometimes also the bot the post was forwarded from.

Common frame, every category:

- Report the channel once from its profile menu (Report), choosing the
  reason the broadcast names, and add a short comment in your own words.
- Also report the specific post (open the post, Report), so the moderators
  have the evidence; a channel report may ask you to select messages
  anyway.
- If the post shows "Forwarded from <bot>", tap the header, open the bot's
  profile, Report, "Report bot", same reason. If the post shows no
  forwarded header, report the channel and the post only.
- Do not forward the post to anyone, do not save its media, do not join or
  engage with the channel beyond what reporting needs. Telegram deletes
  nothing on a promise; the broadcast never promises removal.
- Repeating a report does nothing documented; one report of the channel,
  one of the post, one of the bot.

Personal details (doxxing):

- Reason "Personal Details" on the channel, the post and the bot.
- Routing (decision Q2): the broadcast names the channel (and the bot when
  known) by default; a post link appears only by the admin's recorded
  opt-in, and never when the reporter is the affected person.
- Points to make in the comment: the channel publishes a private person's
  personal data (say which kind) without consent, to intimidate or harass;
  do not repeat the data.

Child abuse (non-sexual abuse, exploitation, grooming):

- Reason "Child Abuse" on the channel, the post and the bot.
- Points to make: that the person is a child, what the channel or post
  does, and why it endangers the child. Do not name the child.
- If what you see is sexual: stop, do not forward or save anything, report
  the channel and the post with "Child Abuse", and report once to a hotline
  listed in [csam-hotlines.md](./csam-hotlines.md). Suspected child sexual
  abuse material itself is never broadcast by the bot; the admin handles it
  through the routing card and stopCA@telegram.org.

Harassment and bullying (including a person's public image posted with
abusive text):

- There is no harassment reason in the static list; pick the closest
  option the live menu offers (for a sexualised image "Pornography", for a
  threat "Violence") or "Other" with a comment [INF].
- Points to make: who is targeted, what the posts do, and whether it is
  repeated.

Impersonation:

- Reason "Fake Account" on the channel, the user or the bot; a person
  being impersonated can also contact @NoToScam.
- Points to make: whom it imitates and what it does with the identity.

Intimate images shared without consent:

- Never the post link; the broadcast names the channel and the bot.
- Reason: "Pornography" or "Personal Details" are the nearest static
  options [INF]; the affected person's own report carries most weight.

What the NGO does in addition (admins, not members): email
abuse@telegram.org with the t.me/<channel>/<post> link and the bot's
@username; for suspected child sexual abuse material, stopCA@telegram.org
from the routing card only.

## Unverified

Items from the research note's "Unverified" section that concern this page:

- That a report on a forwarded channel post is routed to the forward-origin
  bot instead of, or as well as, the channel: no source says so. The
  documented API and the client code address the channel. What Telegram's
  moderators see (for example whether the forward header is shown), whom
  they sanction, and whether the reported channel or bot owner is told:
  undocumented.
- The live, server-driven option tree shown when reporting a channel, post
  or bot (it can differ from the static reason strings and needs a
  logged-in client), including whether any harassment or bullying option
  exists there, and whether channel-level reports always demand selected
  posts.
- iOS and Web: the current iOS report-content code path (only a legacy
  engine function was read) and the Web client were not read.
- English originals of Telegram's Terms, Privacy Policy and EU DSA guidance
  were not retrievable from the researcher's IP (German served). The
  English wording of the "suspend the processing of your notices" sentence
  comes only from the search tool [S]; the German quotes are verbatim.
  English summaries labelled [W] came from the summarising tool.
- How an NGO obtains priority or accepted-sender status for
  abuse@telegram.org or stopCA@telegram.org; whether Telegram is a DSA
  trusted-flagger counterparty; whether individuals (not only
  organisations) are meant to use stopCA@ (the t.me/stopCA description says
  "Report via the in-app button or by emailing stopCA@telegram.org", while
  the Safety page frames both addresses as used by "global third-party
  organizations").
- Telegram deduplication and identical-text rules; the thresholds that
  trigger automatic limits or "frozen" status; whether CSAM hash matching
  covers media relayed through bots; whether upload-via-bot is treated
  differently (nothing documented).
- The fields of https://telegram.org/dsa-report (behind a Cloudflare
  Turnstile challenge; not opened).
- The reason mappings marked [INF] in "What the bot's instructions say"
  need a check on a real device before the Persian copy is written.
