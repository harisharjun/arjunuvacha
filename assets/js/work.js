/* Interactive features for the /work/ portfolio section */
(function () {
    "use strict";
    var D = window.WORK_DATA || {};

    function esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /* Escape, then render markdown links, bare URLs, emails, bold, and bullets */
    function richText(s) {
        var t = esc(s);
        var anchors = [];
        function stash(html) { anchors.push(html); return "\x01" + (anchors.length - 1) + "\x01"; }
        t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, txt, url) {
            return stash('<a href="' + url + '" target="_blank" rel="noopener">' + txt + "</a>");
        });
        t = t.replace(/(https?:\/\/[^\s<]+?)([.,;)]?)(\s|$)/g, function (_, url, punct, tail) {
            var label = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
            return stash('<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>") + punct + tail;
        });
        t = t.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/g, '<a href="mailto:$1">$1</a>');
        t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
        t = t.replace(/(^|\n)[-•] /g, "$1• ");
        t = t.replace(/\x01(\d+)\x01/g, function (_, i) { return anchors[+i]; });
        return t.replace(/\n/g, "<br>");
    }

    /* Typewriter: reveal the reply character by character, then swap in the
       fully formatted HTML (links, bold) at the end. */
    function typeOut(el, finalHtml, onDone) {
        var tmp = document.createElement("div");
        tmp.innerHTML = finalHtml;
        var plain = tmp.textContent || "";
        var i = 0;
        var step = Math.max(2, Math.ceil(plain.length / 110));
        el.textContent = "";
        var log = el.parentNode;
        var timer = setInterval(function () {
            i += step;
            el.textContent = plain.slice(0, i);
            if (log) log.scrollTop = log.scrollHeight;
            if (i >= plain.length) {
                clearInterval(timer);
                el.innerHTML = finalHtml;
                if (log) log.scrollTop = log.scrollHeight;
                if (onDone) onDone();
            }
        }, 24);
    }

    /* ---------- Count-up metrics ---------- */
    function initCountup() {
        var els = document.querySelectorAll("[data-countup]");
        if (!els.length || !("IntersectionObserver" in window)) return;
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (!e.isIntersecting) return;
                io.unobserve(e.target);
                var raw = e.target.textContent.trim();
                var m = raw.match(/^([^0-9]*)([\d.]+)(.*)$/);
                if (!m) return;
                var prefix = m[1], target = parseFloat(m[2]), suffix = m[3];
                var decimals = (m[2].split(".")[1] || "").length;
                var t0 = null;
                function step(ts) {
                    if (!t0) t0 = ts;
                    var p = Math.min((ts - t0) / 1200, 1);
                    var eased = 1 - Math.pow(1 - p, 3);
                    e.target.textContent = prefix + (target * eased).toFixed(decimals) + suffix;
                    if (p < 1) requestAnimationFrame(step);
                }
                requestAnimationFrame(step);
            });
        }, { threshold: 0.4 });
        els.forEach(function (el) { io.observe(el); });
    }

    /* ---------- Floating "Ask Arjun" chat ---------- */
    var chatApi = { open: null };
    function initChat() {
        var launcher = document.getElementById("aa-launcher");
        var panel = document.getElementById("aa-panel");
        var log = document.getElementById("aa-log");
        var form = document.getElementById("aa-form");
        var input = document.getElementById("aa-input");
        var chipsBox = document.getElementById("aa-chips");
        var closeBtn = document.getElementById("aa-close");
        if (!launcher || !panel) return;

        var qa = D.qa || [];
        var workerUrl = (D.worker || "").replace(/\/$/, "");
        var busy = false;

        /* Conversation persists across refreshes */
        var store = { msgs: [], history: [] };
        try {
            var saved = JSON.parse(localStorage.getItem("aaChatV1"));
            if (saved && Array.isArray(saved.msgs)) store = saved;
        } catch (e) { /* fresh start */ }
        var history = store.history || [];
        var greeted = store.msgs.length > 0;

        function persist() {
            try {
                store.msgs = store.msgs.slice(-40);
                store.history = history.slice(-8);
                localStorage.setItem("aaChatV1", JSON.stringify(store));
            } catch (e) { /* storage unavailable — chat still works */ }
        }

        function bubble(html, who, save) {
            var d = document.createElement("div");
            d.className = "aa-msg aa-msg--" + who;
            d.innerHTML = html;
            log.appendChild(d);
            log.scrollTop = log.scrollHeight;
            if (save) { store.msgs.push({ who: who, html: html }); persist(); }
            return d;
        }

        function suggest(n) {
            if (!chipsBox || !qa.length) return;
            chipsBox.innerHTML = "";
            var pool = qa.slice();
            for (var i = 0; i < n && pool.length; i++) {
                var item = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
                (function (q) {
                    var b = document.createElement("button");
                    b.type = "button";
                    b.className = "aa-chip";
                    b.textContent = q;
                    b.addEventListener("click", function () { ask(q); });
                    chipsBox.appendChild(b);
                })(item.q);
            }
        }

        /* Curated fallback matcher (used when no worker is configured or it fails) */
        function localMatch(text) {
            var t = text.toLowerCase();
            var words = t.replace(/[^a-z0-9\s→.-]/g, "").split(/\s+/);
            var best = null, bs = 0;
            qa.forEach(function (item) {
                var s = 0;
                (item.keywords || []).forEach(function (k) {
                    k = k.toLowerCase();
                    if (k.indexOf(" ") > -1) {
                        if (t.indexOf(k) > -1) s += k.length * 2;
                    } else if (words.indexOf(k) > -1) {
                        s += k.length;
                    }
                });
                if (s > bs) { bs = s; best = item; }
            });
            return bs >= 3 ? best : null;
        }

        function fallbackAnswer(q) {
            var hit = localMatch(q);
            return hit ? hit.a :
                "That one's not in my notes yet — but the human version of me would love to answer. " +
                "<a href='mailto:k.harisharjun@gmail.com'>Email him</a> or try a suggestion below.";
        }

        function ask(q) {
            if (busy) return;
            busy = true;
            bubble(esc(q), "user", true);
            input.value = "";
            var typing = bubble('<span class="aa-typing"><i></i><i></i><i></i></span>', "bot");

            function finish(html) {
                var tmp = document.createElement("div");
                tmp.innerHTML = html;
                history.push({ role: "user", content: q });
                history.push({ role: "assistant", content: (tmp.textContent || "").slice(0, 800) });
                if (history.length > 8) history = history.slice(-8);
                store.msgs.push({ who: "bot", html: html });
                persist();
                typeOut(typing, html, function () {
                    suggest(3);
                    busy = false;
                });
            }

            if (workerUrl) {
                var ctrl = ("AbortController" in window) ? new AbortController() : null;
                var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 20000);
                fetch(workerUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: q, history: history }),
                    signal: ctrl ? ctrl.signal : undefined
                }).then(function (r) { return r.json(); }).then(function (data) {
                    if (timer) clearTimeout(timer);
                    finish(data && data.reply ? richText(data.reply) : fallbackAnswer(q));
                }).catch(function () {
                    if (timer) clearTimeout(timer);
                    finish(fallbackAnswer(q));
                });
            } else {
                setTimeout(function () { finish(fallbackAnswer(q)); }, 500 + Math.random() * 400);
            }
        }

        var restored = false;
        function open() {
            panel.hidden = false;
            launcher.classList.add("is-open");
            if (!restored && store.msgs.length) {
                restored = true;
                store.msgs.forEach(function (m) { bubble(m.html, m.who); });
                suggest(3);
            } else if (!greeted) {
                greeted = true;
                bubble("Hi! I'm an AI Arjun built — trained on his career. Ask me what a hiring manager would ask, or tap a suggestion.", "bot", true);
                suggest(3);
            }
            setTimeout(function () { input.focus(); }, 150);
        }
        function close() {
            panel.hidden = true;
            launcher.classList.remove("is-open");
        }

        launcher.addEventListener("click", function () { panel.hidden ? open() : close(); });
        closeBtn.addEventListener("click", close);
        form.addEventListener("submit", function (ev) {
            ev.preventDefault();
            var q = input.value.trim();
            if (q) ask(q);
        });
        chatApi.open = open;
        chatApi.ask = function (q) {
            open();
            setTimeout(function () { if (!busy) ask(q); }, 250);
        };

        /* Draw attention on first load, stop once noticed */
        launcher.classList.add("aa-pulse");
        setTimeout(function () { launcher.classList.remove("aa-pulse"); }, 12000);
        launcher.addEventListener("click", function () { launcher.classList.remove("aa-pulse"); }, { once: true });
    }

    /* ---------- Ask-Arjun nudge buttons ---------- */
    function initNudge() {
        document.querySelectorAll("[data-aa-ask]").forEach(function (b) {
            b.addEventListener("click", function () {
                var q = b.getAttribute("data-aa-ask");
                if (q && chatApi.ask) chatApi.ask(q);
            });
        });
    }

    /* ---------- Tag filters (stories, deep dives — any .work-filterbar) ---------- */
    function initFilters() {
        document.querySelectorAll(".work-filterbar").forEach(function (bar) {
            var scope = document.querySelector(bar.getAttribute("data-target"));
            if (!scope) return;
            var buttons = bar.querySelectorAll(".work-filter");
            buttons.forEach(function (f) {
                f.addEventListener("click", function () {
                    buttons.forEach(function (x) { x.classList.remove("is-active"); });
                    f.classList.add("is-active");
                    var tag = f.getAttribute("data-filter");
                    scope.querySelectorAll("[data-tags]").forEach(function (item) {
                        var tags = (item.getAttribute("data-tags") || "").split("|");
                        item.style.display = (tag === "all" || tags.indexOf(tag) > -1) ? "" : "none";
                    });
                });
            });
        });
    }

    /* ---------- Career metro map ---------- */
    function initMetro() {
        var detail = document.getElementById("work-metro-detail");
        var stations = D.stations || [];
        if (!detail || !stations.length) return;
        var roleEl = detail.querySelector(".work-metro-detail-role");
        var noteEl = detail.querySelector(".work-metro-detail-note");
        function show(idx) {
            var s = stations[idx];
            if (!s) return;
            roleEl.textContent = s.year + " · " + s.role + " · " + s.org;
            noteEl.textContent = s.note;
            detail.hidden = false;
        }
        document.querySelectorAll(".work-station").forEach(function (g) {
            function act() {
                document.querySelectorAll(".work-station").forEach(function (x) { x.classList.remove("is-active"); });
                g.classList.add("is-active");
                show(parseInt(g.getAttribute("data-station"), 10));
            }
            g.addEventListener("click", act);
            g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
        });
    }

    /* ---------- 90-second mode ---------- */
    function init90() {
        var btn = document.getElementById("work-90-toggle");
        var panel = document.getElementById("work-90");
        if (!btn || !panel) return;
        btn.addEventListener("click", function () {
            var on = document.body.classList.toggle("work-mode-90");
            panel.hidden = !on;
            btn.textContent = on ? "↩ Back to the full story" : "⚡ In a hurry? 90-second version";
            if (on) panel.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    }

    /* ---------- Command palette ---------- */
    function initCmdk() {
        var overlay = document.getElementById("work-cmdk");
        if (!overlay) return;
        var input = document.getElementById("work-cmdk-input");
        var list = document.getElementById("work-cmdk-list");
        var toast = null;
        function say(msg) {
            if (toast) toast.remove();
            toast = document.createElement("div");
            toast.className = "work-toast";
            toast.innerHTML = msg;
            document.body.appendChild(toast);
            setTimeout(function () { if (toast) { toast.remove(); toast = null; } }, 6000);
        }
        var facts = [
            "Arjun once visited 11 cities to interview helpdesk users. Ask him which city had the best coffee.",
            "This site is named after a Sanskrit phrase from the Bhagavad Gita — 'Arjun said'.",
            "He cut an ops process from 66 seconds to 28. He notices when your coffee order takes too long.",
            "AIEEE All India Rank 488. He will not bring this up unless you type 'coffee' into a hidden command palette.",
            "EAMCET All India Rank 57 and IIT-JEE AIR 3,135. The math olympiad top-50 finish is just showing off at this point.",
            "His favourite things he's written: <a href='/p/cognitivie-biases-ikea-effect/'>the IKEA Effect</a> and <a href='/p/cognitivie-biases-availability-heuristic/'>the Availability Heuristic</a>.",
            "He keeps a running list of <a href='/p/things-that-made-me-smile/'>things that made him smile</a>. There's a <a href='/p/things-that-made-me-smile-part-02/'>part 2</a>."
        ];
        var cmds = [
            { k: "chat", label: "chat — ask the AI about Arjun", run: function () { if (chatApi.open) chatApi.open(); } },
            { k: "impact", label: "impact — jump to the numbers", run: function () { var el = document.querySelector(".work-metrics"); if (el) el.scrollIntoView({ behavior: "smooth" }); } },
            { k: "journey", label: "journey — the career metro map", run: function () { var el = document.getElementById("work-metro"); if (el) el.scrollIntoView({ behavior: "smooth" }); } },
            { k: "resume", label: "resume — download the PDF", run: function () { window.open("/K-Harish-Arjun-Resume.pdf", "_blank"); } },
            { k: "hire", label: "hire — email Arjun", run: function () { location.href = "mailto:k.harisharjun@gmail.com"; } },
            { k: "blog", label: "blog — read Arjun Uvacha", run: function () { location.href = "/"; } },
            { k: "coffee", label: "coffee — a fun fact", run: function () { say(facts[Math.floor(Math.random() * facts.length)]); } }
        ];
        function render(filter) {
            list.innerHTML = "";
            cmds.filter(function (c) { return !filter || c.k.indexOf(filter) > -1 || c.label.indexOf(filter) > -1; })
                .forEach(function (c, i) {
                    var li = document.createElement("li");
                    li.textContent = c.label;
                    if (i === 0) li.classList.add("is-active");
                    li.addEventListener("click", function () { close(); c.run(); });
                    list.appendChild(li);
                });
        }
        function open() { overlay.hidden = false; input.value = ""; render(""); input.focus(); }
        function close() { overlay.hidden = true; }
        document.addEventListener("keydown", function (e) {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); overlay.hidden ? open() : close(); }
            else if (e.key === "Escape" && !overlay.hidden) close();
            else if (e.key === "Enter" && !overlay.hidden) {
                var first = list.querySelector("li");
                if (first) first.click();
            }
        });
        input.addEventListener("input", function () { render(input.value.trim().toLowerCase()); });
        overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    }

    document.addEventListener("DOMContentLoaded", function () {
        initCountup();
        initChat();
        initNudge();
        initFilters();
        initMetro();
        init90();
        initCmdk();
    });
})();
