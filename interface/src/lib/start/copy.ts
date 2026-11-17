/**
 * Every sentence the way in to the site shows, in one place, grouped by screen.
 *
 * No em dash in any of them, and never "our agents". `{days}`, `{fee}` and `{count}` are filled
 * by the screen that renders them, from the deployment's config and the wizard's step count.
 */
export const START_COPY = {
  notOffered: {
    title: "The full product is not offered here",
    body: "This deployment gives agents a legal body. The treasury and spending rules are on testnet.",
    choose: "Choose a path",
  },
  title: "Choose how your agent gets its legal body",
  needs: "Every path needs this wallet, World ID, and a key for your agent's identity that can send a transaction on Arc.",
  continue: "Continue",
  cards: {
    form: {
      title: "Form a company for my agent",
      body: "Novi Corpus files a new Wyoming company for your agent through doola.",
      time: "About {days} working days",
      timeSandbox: "A few minutes on testnet: a test company, nothing is filed",
      price: "{fee} USDC, paid before filing",
      free: "Free on testnet",
      fullUp: "All places are taken.",
      fullUpLink: "Join the early-access list",
    },
    declare: {
      title: "My agent's company already exists",
      body: "You already have a Wyoming LLC or DAO LLC. You declare it and show you control it.",
      needsProduction: "A document that shows you control the company, checked by a Novi Corpus operator",
      needsSandbox: "On testnet the check is automatic: a test declaration",
      free: "Free on testnet",
    },
    full: {
      title: "The full product",
      tag: "testnet",
      body: "A company, a USDC treasury and spending rules for your agent. {count} steps.",
    },
  },
  escape: {
    sentence: "Only here for the full product? It checks World ID in its own steps.",
    link: "Open the full product",
  },
  none: "This deployment offers no way in yet.",
  unreadable: "This deployment could not be reached.",
  companiesUnreadable: "Your companies could not be read.",
  retry: "Try again",
  home: "Back to the home page",
} as const;
