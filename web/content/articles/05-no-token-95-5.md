# no token, 95/5

**subtitle:** how a project funds itself without printing anything
**read time:** 4 min
**series:** building tagwall, part 5 of 5

---

tagwall has no token. There was no presale, and there's no team allocation, NFT, points scheme or airdrop. The only thing to buy is pixels, and you can't transfer or resell one. You buy it to paint it.

Skipping a token meant skipping the easiest money a crypto project can get, so I should say what pays for this instead.

## the split

When you paint, you pay in the chain's own coin, the one you already pay transaction fees in. The contract splits the payment and sends both parts on before the transaction finishes. Nobody has to claim anything afterwards.

- **95% goes to the treasury**, a single public address that holds the project's money, and every chain uses the same one.
- **5% goes to the referrer**, if the paint named one.
- **Nothing is burned.**

So a paint costing a hundred coins sends ninety-five to the treasury and five to the referrer. With no referrer the treasury gets all hundred. Naming your own wallet as the referrer doesn't get you a discount, because that five goes to the treasury too. And if a referrer's wallet can't accept the payment, the paint still goes through and their share goes to the treasury.

Both numbers are fixed in the published source. You can also read the split straight from the contract on a block explorer, so you don't have to take a web page's word for it.

The referrer is a field in the paint transaction. Whoever sends the paint fills in an address and the contract pays it. There's no signup, dashboard or approval, and no terms I could withdraw later. Anyone running a viewer, a bot or a landing page can put their own address there and get paid the moment the paint lands, for as long as the contract runs.

## why not a token

There's a real case for a token. It pays for development before there are any users, and it gives early supporters a reason to care. I understand why almost every project does it.

My problem is what it would do to this project. tagwall is meant to be permanent and unowned, and boring on purpose. A token comes with a price chart, and the chart attracts people who care about the chart more than the wall. It also comes with a supply schedule I'd control, a treasury held in something I issued myself, and questions about who got what, at what price, and when they can sell. Those are fair questions to ask of any token, and they never go away. With no token there's no supply for me to hold, so there's nothing for me to dump and you don't need to trust that I won't.

It would also undo what part 4 was about. A token needs an address allowed to create it, an address that deploys it, a pool of it paired with real money on an exchange, and probably a shared wallet holding the rest. Each of those is an address with special powers. The accurate description of the project would change from "no owner" to "no owner of the wall, but somebody obviously controls the token".

## how it funds itself

The treasury holds each chain's own coin and pays for the usual things, which are development, hosting, marketing and keeping the viewer online. It has one source of income. It grows when somebody paints and at no other time.

Nothing is printed or sold, and no supply unlocks on a schedule. If nobody paints, the treasury doesn't grow, and the only fix is to build something people want to paint on. The balance is a public address on a public chain, so you can check it whenever you like without asking me or waiting for a report.

There's a less flattering side to this. Before launch I ran a simulation across thousands of randomised activity scenarios, and the result was blunt. At realistic early activity, and at the coin prices of the time, paint revenue doesn't fund an operation. It covers hosting and keeping the site running. Growth has to come slowly. A token would have filled that gap early by selling a future the project hadn't earned yet, and I decided against it.

The upside is a simple incentive. The project only does well if people paint, and anyone can check whether they are.

## what's being sold

A square on a wall nobody owns is cheap next to what projects already spend on being noticed. The money that buys a week of trending placement buys a square that's still in the chain's history after the campaign has ended, and even after the project's own site has gone down.

An advert stops when you stop paying. Here, anybody can pay ten percent more and take your square, so the wall keeps changing. The fact that you painted it goes into a log nobody can revise, and nobody can erase it.

---
