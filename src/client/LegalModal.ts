import { assetUrl } from "@openfront/shared/AssetUrls";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import { renderMarkdown } from "./Markdown";

/**
 * Landpot's Terms of Service and Privacy Policy, at /terms and /privacy
 * (registered in Main.ts). The text lives in resources/legal/*.md so it can be
 * edited without touching code.
 */
abstract class LegalDocModal extends BaseModal {
  protected abstract readonly doc: "terms" | "privacy";
  @state() private markdown: string | null = null;
  @state() private failed = false;

  protected renderHeaderSlot() {
    return modalHeader({
      title:
        this.doc === "terms"
          ? translateText("landpot.legal_terms")
          : translateText("landpot.legal_privacy"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    if (this.failed) {
      return html`<p class="px-6 py-6 text-white/70">
        ${translateText("landpot.legal_failed")}
      </p>`;
    }
    if (this.markdown === null) {
      return html`<p class="px-6 py-6 text-white/50 lp-mono text-[13px]">
        ${translateText("common.loading")}
      </p>`;
    }
    return html`
      <article
        class="max-w-[72ch] mx-auto px-6 py-6 text-[15px] leading-relaxed text-white/80
          [&_h1]:text-[28px] [&_h1]:text-white [&_h1]:mb-2
          [&_h1+p]:font-[family-name:var(--font-mono)] [&_h1+p]:text-[12px] [&_h1+p]:text-white/45 [&_h1+p]:mb-8
          [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mt-8 [&_h2]:mb-3
          [&_p]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-4 [&_li]:mb-1.5
          [&_strong]:text-white [&_strong]:font-semibold
          [&_a]:text-[#c6ff3d] [&_a]:underline [&_code]:font-[family-name:var(--font-mono)] [&_code]:text-[13px]"
      >
        ${renderMarkdown(this.markdown)}
      </article>
    `;
  }

  protected onOpen(): void {
    if (this.markdown !== null) return;
    this.failed = false;
    fetch(assetUrl(`legal/${this.doc}.md`))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((md) => (this.markdown = md))
      .catch(() => (this.failed = true));
  }
}

@customElement("terms-modal")
export class TermsModal extends LegalDocModal {
  protected routerName = "terms";
  protected readonly doc = "terms" as const;
}

@customElement("privacy-modal")
export class PrivacyModal extends LegalDocModal {
  protected routerName = "privacy";
  protected readonly doc = "privacy" as const;
}
