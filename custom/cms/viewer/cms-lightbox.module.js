/**
 * MAERS CMS - Lightbox Module (cms-lightbox.module.js)
 * 职责：图片灯箱初始化、显示、关闭、滚轮/键盘切换
 * @version 4.0.0 - ES6 Module
 */

const FADE_DELAY = 300;

// 图片列表状态
let _imageList = [];
let _wheelCooldown = false;
let _currentIndex = -1;

/** 收集当前页面中所有可用于灯箱展示的图片 src 列表 */
function _collectImages() {
    const imgs = Array.from(document.querySelectorAll(
        '.markdown-body img, .vditor-ir img, .vditor-wysiwyg img, .vditor-sv img, .paper-sheet img'
    )).filter(img => {
        if (!img.src) return false;
        if (img.closest('.header-title')) return false;
        if (img.closest('.brand-logo')) return false;
        if (img.closest('button')) return false;
        if (img.closest('.spatial-card')) return false;
        if (img.classList.contains('zoom-trigger-icon')) return false;
        return true;
    });
    return [...new Set(imgs.map(i => i.src))]; // 去重
}

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

        // 鼠标滚轮切换（400ms 冷却防连跳）
        lightbox.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (_imageList.length <= 1 || _wheelCooldown) return;
            _wheelCooldown = true;
            setTimeout(() => { _wheelCooldown = false; }, 250);
            if (e.deltaY > 0) _switchTo(_currentIndex + 1);
            else _switchTo(_currentIndex - 1);
        }, { passive: false });
    }

    if (closeBtn) {
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeLightbox();
        });
    }

    if (lightboxImg) {
        lightboxImg.addEventListener("click", (e) => {
            e.stopPropagation();
        });
    }

    // 全局图片点击代理
    document.addEventListener("click", (e) => {
        const target = e.target;
        if (target.tagName === "IMG") {
            if (
                target.classList.contains("zoom-trigger-icon") ||
                target.closest(".header-title") ||
                target.closest(".brand-logo") ||
                target.closest("button") ||
                target.closest(".tag-toggle-btn") ||
                target.closest(".spatial-card")
            ) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            showLightbox(target.src);
            return;
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

    // 键盘方向键切换、Esc 关闭
    document.addEventListener("keydown", (e) => {
        const lb = document.getElementById("img-lightbox");
        if (!lb || !lb.classList.contains("active")) return;
        if (e.key === "Escape") closeLightbox();
        if (e.key === "ArrowRight" || e.key === "ArrowDown") _switchTo(_currentIndex + 1);
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") _switchTo(_currentIndex - 1);
    });
}

/** 切换到指定索引的图片（循环） */
function _switchTo(index) {
    if (_imageList.length === 0) return;
    _currentIndex = (index + _imageList.length) % _imageList.length;
    const img = document.getElementById("lightbox-img");
    if (!img) return;
    img.src = _imageList[_currentIndex];
}

export function showLightbox(src) {
    const lb = document.getElementById("img-lightbox");
    const img = document.getElementById("lightbox-img");
    if (lb && img) {
        // 每次打开时重新收集当前页面图片列表
        _imageList = _collectImages();
        _currentIndex = _imageList.indexOf(src);
        if (_currentIndex === -1) {
            // 若 src 不在列表里，直接显示这张并单独成列表
            _imageList = [src];
            _currentIndex = 0;
        }
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
            _imageList = [];
            _currentIndex = -1;
        }, FADE_DELAY);
    }
}

export const Lightbox = {
    initLightbox,
    showLightbox,
    closeLightbox
};
