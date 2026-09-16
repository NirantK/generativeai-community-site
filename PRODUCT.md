# GenerativeAI Community

A community website for people building, researching, and practically using generative AI. Preserve the existing dark, terminal-inspired visual identity and published community information.

## Current work

- LinkedIn is the only sign-in provider. Membership applications use a human form or a scoped agent API after browser consent.
- Applicant background is self-reported; LinkedIn OIDC provides available basic identity and email, not complete job or education history.
- Students, people between roles, and people without formal education can apply.
- Clear evidence can be approved; ambiguous cases and model failures go to human review. No automatic rejection in v1.
- Invitations are delivered through Cloudflare Email Service from noreply@genaicommunity.ai. Delivery is distinct from community membership.
- Events incorporates historical demos while preserving archive URLs.
- Reuse the LinkedIn logo and banner. Clearly distinguish true vector assets from raster artwork embedded in SVG.
- Deploy only through GitHub Actions to existing Cloudflare Pages, with a separate private admissions Worker and isolated staging resources.

## Launch gates

Keep email and automatic approvals paused until the administrator, WhatsApp invitation, and controlled delivery checks are complete. Test the owner's real LinkedIn login once; use synthetic signed OIDC responses for repeatable regression tests.
