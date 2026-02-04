/**
 * MAERS CMS - Lightbox Module (cms-lightbox.module.js)
 * 职责：图片灯箱初始化、显示、关闭
 * @version 3.0.0 - ES6 Module
 */

const FADE_DELAY = 300;

export function initLightbox() {
    if (document.getElementById("img-lightbox")) return;

    const lightboxHtml = `
    <div id="img-lightbox" class="lightbox-overlay">
      <button class="lightbox-close">&times;</button>
      <img id="lightbox-img" class="lightbox-img" src="">
    </div>
  `;
    document.body.insertAdjacentHTML("beforeend", lightboxHtml);

    const lightbox = document.getElementById("img-lightbox");
    const lightboxImg = document.getElementById("lightbox-img");
    const closeBtn = document.querySelector(".lightbox-close");

    if (lightbox) {
        lightbox.addEventListener("click", (e) => {
            if (e.target === lightbox) closeLightbox();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // 防止冒泡触发其他点击事件
            closeLightbox();
        });
    }

    if (lightboxImg) {
        lightboxImg.addEventListener("click", (e) => {
            e.stopPropagation();
        });
    }

    document.addEventListener("click", (e) => {
        const target = e.target;
        if (target.tagName === "IMG") {
            if (
                target.classList.contains("zoom-trigger-icon") ||
                target.closest(".header-title") ||
                target.closest(".brand-logo") ||
                target.closest("button") ||  // [Fix] Ignore images inside buttons (e.g. History/Quick Access)
                target.closest(".tag-toggle-btn") // Specific explicit check just in case
            ) {
                return;
            }

            if (
                target.closest(".markdown-body") ||
                target.closest(".immersive-layer") ||
                target.closest(".main-card") ||
                target.closest("#vditor-container") ||
                target.closest(".vditor-content") ||
                target.closest(".vditor-reset")
            ) {
                e.preventDefault();
                e.stopPropagation();
                showLightbox(target.src);
                return;
            }
        }

        const vditorImgWrapper = target.closest(".vditor-ir__node--preview");
        if (vditorImgWrapper) {
            const img = vditorImgWrapper.querySelector("img");
            if (img && (target === vditorImgWrapper || target.contains(img))) {
                e.preventDefault();
                e.stopPropagation();
                showLightbox(img.src);
            }
        }
    }, true);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeLightbox();
    });
}

export function showLightbox(src) {
    const lb = document.getElementById("img-lightbox");
    const img = document.getElementById("lightbox-img");
    if (lb && img) {
        img.src = src;
        lb.classList.add("active");
        document.body.style.overflow = "hidden";
    }
}

export function closeLightbox() {
    const lb = document.getElementById("img-lightbox");
    if (lb) {
        lb.classList.remove("active");
        document.body.style.overflow = "";
        setTimeout(() => {
            const img = document.getElementById("lightbox-img");
            if (img) img.src = "";
        }, FADE_DELAY);
    }
}

export const Lightbox = {
    initLightbox,
    showLightbox,
    closeLightbox
};
