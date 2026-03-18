# Legal Compliance Architecture

This document outlines the legal compliance strategy for the SAIFAC landing page and waitlist, specifically focusing on EU (GDPR) and Czech Republic requirements.

## 1. What We Added

### Privacy Policy & Data Controller Identification (`/privacy`)

**What it is:** A dedicated page explaining how we handle user data, generated using a compliant template (Termly).
**Why we added it:** Under GDPR, any collection of personal data (including email addresses for a waitlist) requires explicit consent and a clear Privacy Policy.
**Key elements included:**

- Identification of the Data Controller (Juraj Oravec) including IČO, registered address, and contact email.
- Explanation of what is collected (emails) and why (to notify users of product launch/alpha/beta).
- Mention of data storage in Supabase (hosted in the EU).
- A clause about our use of Plausible Analytics.

### The "Imprint" (Základní údaje)

**What it is:** The business identification details (Name, IČO, Address, Registry).
**Why we added it:** Czech Civil Code (§ 435) requires anyone acting as an entrepreneur to disclose their identifying information on their website.
**Where it lives:** To keep the landing page clean, we placed this directly at the top of the `/privacy` page. This satisfies both the Czech legal requirement to have the info "on the website" and the GDPR requirement to clearly identify the Data Controller.

### Waitlist Consent Flow (`WaitlistModal.tsx`)

**What it is:** The UI flow for joining the waitlist.
**Why we designed it this way:**

- It clearly states the purpose: "We'll only email you about SAIFAC updates and launch/alpha announcements."
- It includes a direct link to the Privacy Policy right next to the submit button.
- It uses a two-step flow (Email -> GitHub Star) to capture the high-value email first while staying compliant, before asking for the GitHub star.

## 2. What We Did NOT Add

### Cookie Consent Banner (Cookies lišta)

**What it is:** A popup blocking tracking scripts until the user clicks "Accept".
**Why we didn't add it:** We use **Plausible Analytics**, which is a privacy-first, cookieless analytics platform. It does not collect Personally Identifiable Information (PII) or track users across devices. Because we do not use Google Analytics, Facebook Pixels, or embedded YouTube videos (which drop tracking cookies), we are legally exempt from the EU ePrivacy Directive and Czech Electronic Communications Act mandate for a cookie banner.

### Terms and Conditions (VOP - Všeobecné obchodní podmínky)

**What it is:** A legal contract between the service provider and the user regarding the use of a product or service.
**Why we didn't add it:** We are not currently selling a product, offering a SaaS platform, or processing payments. The website is purely an informational landing page collecting emails for a waitlist. Until users can create accounts and use the SAIFAC software, formal T&Cs are not required.

## 3. Future Considerations

If the scope of the website expands, these items will need to be revisited:

- **Adding YouTube/Vimeo embeds:** Use their privacy-enhanced modes (`youtube-nocookie.com`), otherwise a cookie banner will be required.
- **Adding Google Fonts:** The current setup uses Next.js `next/font` which self-hosts the fonts. If a CDN link to Google Fonts is ever added, it could theoretically violate GDPR by exposing visitor IPs to Google.
- **Product Launch:** When SAIFAC is officially launched and users can sign up for the platform, full Terms of Service (VOP) will need to be drafted and added.
