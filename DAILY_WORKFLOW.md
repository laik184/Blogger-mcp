# Daily Blogger workflow

Use this prompt in a ChatGPT workspace that has connected the Blogger AI Publisher MCP server. The current ChatGPT Plus account cannot run the write tools through a custom MCP server, and this instruction does not create a scheduled task.

## Ready-to-use prompt

> At 8:00 AM Asia/Kolkata, work on one article for my authorized Blogger blog. ChatGPT itself must do the topic research, factual review, SEO planning, writing, and editorial decisions; use the Blogger server only to read posts, search for duplicates, create or update a draft, and verify its status.
>
> 1. Read recent live posts, drafts, and scheduled posts. Search the blog for the topic and close variants before choosing it. Skip topics that overlap substantially with an existing post.
> 2. Pick one niche-relevant topic with a clear reader need. Research reliable primary or authoritative sources, open and verify each source, and keep a source list with claims supported by those sources. Do not invent statistics, quotations, dates, or citations.
> 3. Plan a distinct search intent and useful title, then write an original, helpful, SEO-friendly article. Use accurate headings, a concise introduction, practical examples, and a clear conclusion. Add Blogger-safe HTML and a small set of relevant labels.
> 4. Review the draft for factual support, copied phrasing, completeness, readability, and title/topic overlap. If key claims cannot be verified, choose another topic or omit those claims.
> 5. Create the article as a Blogger Draft with a unique idempotency key. Never use a tool that can publish during this scheduled run. After creation, verify the same post ID and `DRAFT` status with the Blogger server. Report the post ID, title, short summary, labels, sources, and any remaining uncertainty.
> 6. Stop after draft verification. Do not publish from a scheduled run. Publishing requires a separate interactive request, a current explicit instruction from me, a verified draft, ChatGPT's action confirmation when prompted, and `PUBLISH_ENABLED=true` on the server.
>
> If the Blogger server cannot read the blog or a duplicate scan is capped, do not create a draft. If draft creation returns an uncertain result, search existing posts and report that manual verification is needed; do not retry under a new key until I confirm no draft was created.

## Scheduling status

This project does not invoke the OpenAI API, schedule a job on its own, or run ChatGPT in the background. ChatGPT tasks can run at exact times on eligible paid plans, but current documentation lists supported app sources and warns that approval-requiring actions pause. It does not document custom MCP write tools as a scheduled task capability. The prompt is therefore for a future supported setup or manual use, not an active 8:00 AM automation.
