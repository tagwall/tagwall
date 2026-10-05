# the contract was the easy part

**subtitle:** keeping a six-chain canvas visible on free public rpcs
**read time:** 5 min
**series:** building tagwall, part 2 of 5

---

The contract has been finished since May. It can't be changed, so once it was deployed there was nothing left to do on it. All the work since has gone into something I assumed would be easy, which is getting a million pixels on six chains to show up in a browser, fast and free, for a visitor who doesn't have a wallet.

## free servers fail without telling you

A browser can't talk to a blockchain directly. It goes through an RPC endpoint, which is somebody else's server in front of the chain, and tagwall uses the free public ones. I'd been thinking of each one as either up or down, and I had a health check that told me which.

The site asks those servers two kinds of question. "What does the contract say right now" feeds the numbers in the page header. "Give me everything that has ever been painted" draws the wall, and it's a lot more expensive to answer. Over a few weeks this summer several free providers stopped answering it. One moved it behind a paid token. Another removed it and kept serving everything else as normal.

On four of the six chains you got a header full of statistics above a blank wall. My health checks passed the whole time, because they only asked the cheap question.

I've since written a test script that asks each server what the site actually asks, the same way, from the same web address. A server that refuses, wants a token, or has thrown away old history comes off the list, and the list has a date on it.

## every chain is different

No server will hand over a chain's whole history in one request, so the site asks for it in slices. I thought slice size was a setting I'd tune once and forget.

HyperEVM's free servers allow 1,000 blocks per request. Ethereum, Base, BSC and PulseChain allow about 9,500. Robinhood Chain produces blocks so fast that it needs 500,000 at a time or the request count gets silly, and the only other provider for that chain allows 10,000, so in practice there's no backup. On BSC I found exactly one free server that will answer at all, and it takes 15 to 24 seconds per slice.

## two defaults that cost me a week

Both are in the library the site uses to talk to chains.

Every request gets a 10 second timeout. Loading a full wall fires about 200 requests at once, and on an ordinary home connection all of them timed out, moved to the next server and timed out again, so the loading animation never stopped. I've set it to 30 seconds.

The other is that when you give the library a list of servers, it always starts with the first. That's what you want from a backup list. It's bad for spreading load, because the first server takes every request until it starts refusing them, and that's how you get rate-limited off a free provider. tagwall rotates now, and each refresh starts with a different server.

Requests for history go to tagwall's own cache on Cloudflare before anywhere else. Old blocks don't change, so once a slice is far enough in the past the answer can be stored for good. A BSC slice that took 20 seconds comes back in about 300 milliseconds.

## the snapshot

Replaying a chain's entire history for every new visitor was never going to last. The wall now loads from a snapshot, one file per chain with every pixel painted up to a certain block. A scheduled job builds it. The colours are already inside each paint transaction, so nothing extra has to be stored on-chain. The browser downloads the file, draws the wall, and then checks the chain only for what's happened since.

I expected the limit to be speed or bandwidth, and it was storage writes. Cloudflare's free plan allows 1,000 a day and my first version used 980 in seven and a half hours, a pace of about 3,100 a day. Nearly all of them were bookkeeping, like bumping a counter or refreshing a timestamp on a chain where nothing had happened.

Now the job only writes when something has changed, which comes to 288 a day. Visitors can't tell the difference, since the browser catches up from the snapshot by itself.

## the bug i liked least

The snapshot job keeps a bookmark of how far through the chain it has read. Each run steps back a bit before carrying on, because the newest blocks on any chain can still be reshuffled and need a second look. My first version did that by setting the bookmark to a fixed distance behind the latest block.

On a slow chain that works. Robinhood Chain produces around 600 blocks a minute, and the job at the time ran every two minutes, so by the next run the chain had moved about 1,200 blocks and my "step back" of 512 was really a jump forward. Each run skipped roughly 700 blocks without any error. A paint in one of those gaps would never have shown up on the wall. When the bookmark steps back now, it is only allowed to move backwards.

## 82 requests down to two

Last, I measured what one new visitor costs. A single page load was making 82 requests to tagwall's Cloudflare layer and around 44 more straight to chain servers. The free plan allows 100,000 requests a day, so the site topped out at roughly 1,500 page views a day. A campaign that worked would have taken it down.

Most of it came from three places. One request fired before the snapshot arrived, replayed the entire chain history anyway, and threw the result away when the snapshot landed. A live-updates listener, on chains that don't support it properly, fell back to re-asking the chain every four seconds for every open tab, and it never stopped. The activity feed made a separate request per row to get the time.

I'd like to say the fixes were clever. They weren't, I just hadn't looked at what the page was doing. A new visitor now costs about two requests, and the same free plan covers around 50,000 page views a day.

The contract hasn't changed through any of this, because it can't. Everything that went wrong was somewhere else in the stack.

the wall is live, go paint a pixel

---
