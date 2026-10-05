# why i built a website nobody can delete

**subtitle:** a record is only permanent if its author cannot edit it
**read time:** 5 min
**series:** building tagwall, part 1 of 5

---

The Million Dollar Homepage went up in 2005. A student sold a million pixels on a single web page, people bought them in blocks of a hundred, and the grid that came out of it is a decent record of what the web looked like when it was still mostly strangers with logos.

It still loads, because one person keeps renewing a domain and paying a hosting bill. A large share of the links on it go nowhere now. Harvard's Library Innovation Lab counted in 2017 and found more than a third already dead or redirecting, and a 2025 recount found fewer than one in five still working. The page stays up for as long as somebody keeps choosing to keep it up.

I kept watching a faster version of the same decay in crypto. A project launches, there's noise for a week, the telegram goes quiet, the site goes down, and a year later there's nothing left to show it happened. Even the things sold as permanent turn out to have an admin behind them, and that person eventually gets bored, or gets bought, or gets a letter.

I wanted to build something that didn't work like that, and the only version I could take seriously was one where I took myself out of it.

## what it is

tagwall is a wall of 1,000,000 pixels, 1250 by 800, and all of it is held inside a single smart contract, which is a program that runs on a public blockchain. You paint a rectangle, you can attach an https link to it, and the paint is a transaction on that chain. Looking at the wall costs nothing and needs no wallet or account.

The same contract is deployed on six chains: PulseChain, Ethereum, Base, BSC, HyperEVM and Robinhood Chain. On the first four it has the same address. The contract isn't given any settings when it's created. It asks the chain which one it's on, so the code being deployed is identical everywhere, and there's a deployment method that puts identical code at the same address on every chain. Part 4 of this series covers that.

Painting costs a few cents per pixel, paid in whatever coin the chain uses. Painting over somebody costs at least ten percent more than they paid. The first hundred painters on each chain hold a genesis rank, which is worked out from the chain's own record of who painted what and when, and it can never be reassigned.

## the part that took the commitment

The contract has no owner. It has no admin function, nothing that pauses it, no way to upgrade it, and no address with powers the others don't have. The source is verified on Sourcify, an independent service that checks published code against the program actually running on the chain, and the result is an exact match. You don't have to take any of this on my word, and checking it takes about thirty seconds.

Plenty of people told me to keep a switch, just a small one, just in case.

I understand the argument and I still think it's wrong for this project. A wall I can edit isn't a permanent record. It's my opinion with extra steps. If I can reach in and change what the wall says, then everything the wall says about the past really depends on my mood today, and on whether you'll be able to trust whoever holds my keys in ten years.

Removing the switch has a cost, and part 4 goes through it. There are no bug fixes and no rescue. There's no version two of this deployment either, only a different contract at a different address that nobody is obliged to look at. In exchange, the wall doesn't depend on me at all. It lasts as long as the chain does.

To keep it usable, the official viewer at tagwall.io applies a content filter in the browser. That's a choice about presentation, and I think the viewer is the right place for it. The contract underneath is neutral infrastructure, the way the chain underneath it is, and the whole stack is open source, so anyone can run their own copy of the site.

## the moment it worked

For a while most of the paint on the wall was the project's own, which proves nothing.

Then, in June, a wallet I had never seen (0x19c1...4759) painted a 36 by 36 square in the top left corner of the PulseChain wall, pointed it at plstart.me, and paid 6,994,800 PLS to do it. That wallet holds Genesis #3 on PulseChain, and it's first on the leaderboard by spend, ahead of the wallet the project used to seed the wall.

Twenty six tags on PulseChain is a small number. But it was the first time somebody outside the project decided a square was worth more to them than it was to me, and paid for it. It has happened once, and this early that's about all the evidence there is.

## what permanence means when the surface can change

The reaction I get most often is that a wall where anyone can paint over you can't be permanent. There are two separate things here, and they behave differently.

The visible surface is contested. Pixels change hands, the price to take a square goes up ten percent at a time, and quiet areas drift back down toward the floor price and get taken by somebody new. That part is meant to move. If the first buyer owned a square forever, the wall would fill up once and then stop changing.

The record is different. The transaction that says this address painted these pixels, at this price, at this point in the chain's history, stays in that history, and no later paint touches it. Somebody can take your square. Nobody can erase that you painted it.

The Million Dollar Homepage is a snapshot of 2005 that survives because one person keeps paying. tagwall is a surface that keeps changing, on top of a history that nobody, including me, can revise.

---
