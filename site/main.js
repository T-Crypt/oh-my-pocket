// Pi Pocket site: copy buttons, the install tabs, and sections that rise into view. The page works without this
// script: the `js` class is what hides a section until it arrives.

const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!still && "IntersectionObserver" in window) {
    document.documentElement.classList.add("js");
    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("shown");
                    observer.unobserve(entry.target);
                }
            }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    for (const element of document.querySelectorAll(".reveal")) {
        // Siblings in a grid arrive one after another.
        const siblings = [...element.parentElement.children].filter((each) =>
            each.classList.contains("reveal"),
        );

        element.style.transitionDelay = `${Math.min(siblings.indexOf(element), 6) * 50}ms`;
        observer.observe(element);
    }
}

function commandText(element) {
    // Copy commands only: drop prompts and comments, and keep one command per line.
    const clone = element.cloneNode(true);

    for (const node of clone.querySelectorAll(".p, .c")) {
        node.remove();
    }

    return clone.textContent
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

async function copy(button, text) {
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        button.classList.add("done");
    } catch {
        button.textContent = "Press Ctrl+C";
    }

    setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("done");
    }, 1600);
}

for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () =>
        copy(button, commandText(document.querySelector(button.dataset.copy))),
    );
}

const tabs = [...document.querySelectorAll('[role="tab"]')];

function select(tab) {
    for (const other of tabs) {
        const on = other === tab;

        other.setAttribute("aria-selected", String(on));
        other.tabIndex = on ? 0 : -1;
        document.getElementById(other.getAttribute("aria-controls")).hidden = !on;
    }
}

for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

        if (!step) {
            return;
        }

        const next = tabs[(index + step + tabs.length) % tabs.length];

        select(next);
        next.focus();
    });
}

const activeCopy = document.querySelector("[data-copy-active]");

activeCopy?.addEventListener("click", () => {
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])');

    if (panel) {
        copy(activeCopy, commandText(panel));
    }
});
