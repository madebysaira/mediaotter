if (typeof mediaotter === "undefined") {
    var mediaotter = {};
    // Escape string for JSON value.
    function _moEsc(s) {
        var o = String(s);
        o = o.split("\\").join("\\\\");
        o = o.split('"').join('\\"');
        o = o.split("\n").join("\\n");
        o = o.split("\r").join("\\r");
        o = o.split("\t").join("\\t");
        return o;
    }
    // GetProjectFolder: return project path / file.fsName or "".
    mediaotter.getProjectFolder = function() {
        try {
            if (typeof app === "undefined" || !app.project) { return ""; }
            try {
                if (typeof app.project.path !== "undefined") {
                    var p = app.project.path;
                    if (p === null || typeof p === "undefined") { return ""; }
                    return String(p);
                }
            } catch (e) {}
            try {
                if (typeof app.project.file !== "undefined") {
                    var f = app.project.file;
                    if (f === null || typeof f === "undefined") { return ""; }
                    try { if (typeof f.fsName !== "undefined") { return String(f.fsName); } } catch (e2) {}
                    return "";
                }
            } catch (e) {}
            return "";
        } catch (e) { return ""; }
    };
    // importFile: import file into Premiere or AE.
    mediaotter.importFile = function(jsonStr) {
        try {
            var args = null;
            try {
                if (typeof jsonStr === "string") { args = eval("(" + jsonStr + ")"); }
                else if (typeof jsonStr === "object" && jsonStr !== null) { args = jsonStr; }
                else { return '{"ok":false,"error":"Invalid arguments"}'; }
            } catch (e) { return '{"ok":false,"error":"Invalid arguments: ' + _moEsc(e.toString()) + '"}'; }
            var filePath = args.filePath;
            var binName = args.binName ? String(args.binName) : "MediaOtter";
            var addToTimeline = args.addToTimeline ? true : false;
            var addToComp = args.addToComp ? true : false;
            if (typeof app === "undefined" || !app.project) { return '{"ok":false,"error":"No project open"}'; }
            if (!filePath || typeof filePath !== "string" || filePath === "") { return '{"ok":false,"error":"File not found: ' + _moEsc(String(filePath)) + '"}'; }
            var fileObj = null;
            try { fileObj = new File(filePath); if (!fileObj.exists) { return '{"ok":false,"error":"File not found: ' + _moEsc(filePath) + '"}'; } } catch (e) { return '{"ok":false,"error":"File not found: ' + _moEsc(String(filePath)) + '"}'; }
            var itemName = "";
            try { itemName = fileObj.name ? String(fileObj.name) : ""; } catch (e) {}
            if (!itemName) { var s = String(filePath); var a = s.lastIndexOf("/"); var b = s.lastIndexOf("\\"); if (b > a) { a = b; } if (a !== -1) { itemName = s.substring(a + 1); } else { itemName = s; } }
            var isPremiere = false; var isAE = false;
            try { isPremiere = typeof app.project.activeSequence !== "undefined"; } catch (e) {}
            try { isAE = typeof app.project.activeItem !== "undefined"; } catch (e) {}
            if (isPremiere) {
                var bin = null;
                try {
                    // find existing bin, else create it
                    if (app.project.rootItem) {
                        var kids = app.project.rootItem.children;
                        for (var ki = 0; ki < kids.numItems; ki += 1) {
                            try { if (String(kids[ki].name) === binName) { bin = kids[ki]; break; } } catch (eK) {}
                        }
                        if (!bin && typeof app.project.rootItem.createBin === "function") {
                            try { bin = app.project.rootItem.createBin(binName); } catch (eBin) {}
                        }
                    }
                    if (!bin) { bin = app.project.rootItem; }
                } catch (e) { try { bin = app.project.rootItem; } catch (e2) { bin = null; } }
                try {
                    if (typeof app.project.importFiles === "function") { app.project.importFiles([filePath], true, bin, false); }
                    else { return '{"ok":false,"error":"Import not supported in this host"}'; }
                } catch (eImp) { return '{"ok":false,"error":"' + _moEsc(eImp.toString()) + '"}'; }
                if (addToTimeline) {
                    try {
                        if (app.project.activeSequence) {
                            var seq = app.project.activeSequence;
                            try {
                                if (typeof seq.insertClip === "function") {
                                    var pos = null;
                                    try { if (typeof seq.getPlayerPosition === "function") { pos = seq.getPlayerPosition(); } } catch (ePos) {}
                                    try { seq.insertClip(filePath, pos); } catch (eIns) {}
                                }
                            } catch (eVt) {}
                        }
                    } catch (e) {}
                }
                return '{"ok":true,"itemName":"' + _moEsc(itemName) + '"}';
            }
            if (isAE) {
                var footage = null;
                try {
                    var imp = new ImportOptions(new File(filePath));
                    try { footage = app.project.importFile(imp); } catch (e1) {
                        try {
                            if (typeof app.project.importFiles === "function") {
                                var f = new File(filePath);
                                try { footage = app.project.importFiles([f]); } catch (eF1) {}
                            }
                        } catch (eF) {}
                        if (!footage) { throw e1; }
                    }
                } catch (eImpAE) {
                    try {
                        if (typeof app.project.importFiles === "function") {
                            var f2 = new File(filePath);
                            try { footage = app.project.importFiles([f2]); } catch (eF2) {}
                        }
                    } catch (e) {}
                    if (!footage) { try { var imp2 = new ImportOptions(new File(filePath)); footage = app.project.importFile(imp2); } catch (e3) {} }
                    if (!footage) { return '{"ok":false,"error":"' + _moEsc(eImpAE.toString()) + '"}'; }
                }
                try {
                    if (footage) {
                        var folder = null;
                        try { if (app.project.items && typeof app.project.items.addFolder === "function") { folder = app.project.items.addFolder(binName); } } catch (eF) {}
                        if (folder) { try { footage.parentFolder = folder; } catch (ePar) {} }
                        try { if (footage.name) { itemName = String(footage.name); } } catch (eN) {}
                    }
                } catch (e) {}
                if (addToComp) {
                    try {
                        var ai = app.project.activeItem;
                        if (ai) {
                            var isComp = false;
                            try { if (typeof CompItem !== "undefined" && ai instanceof CompItem) { isComp = true; } } catch (eC) {}
                            if (!isComp) { try { if (ai.layers && typeof ai.layers.add === "function") { isComp = true; } } catch (eL) {} }
                            if (isComp) { try { ai.layers.add(footage); } catch (eAdd) {} }
                        }
                    } catch (e) {}
                }
                return '{"ok":true,"itemName":"' + _moEsc(itemName) + '"}';
            }
            // Unknown host: try Premiere style then AE style
            try {
                var bin2 = null; try { bin2 = app.project.rootItem; } catch (e) {}
                try { if (app.project.rootItem && typeof app.project.rootItem.createBin === "function") { try { bin2 = app.project.rootItem.createBin(binName); } catch (e) {} } } catch (e) {}
                if (typeof app.project.importFiles === "function") { app.project.importFiles([filePath], true, bin2, false); return '{"ok":true,"itemName":"' + _moEsc(itemName) + '"}'; }
            } catch (e) {}
            try { var imp3 = new ImportOptions(new File(filePath)); var ft3 = app.project.importFile(imp3); try { if (ft3 && ft3.name) { itemName = String(ft3.name); } } catch (e) {} return '{"ok":true,"itemName":"' + _moEsc(itemName) + '"}'; } catch (e3) { return '{"ok":false,"error":"' + _moEsc(e3.toString()) + '"}'; }
        } catch (e) { try { return '{"ok":false,"error":"' + _moEsc(e.toString()) + '"}'; } catch (e2) { return '{"ok":false,"error":"Unknown error"}'; } }
    };
    // revealInFinder: show file in OS file manager.
    mediaotter.revealInFinder = function(filePath) {
        try {
            var fp = String(filePath);
            var isMac = false; try { isMac = (typeof $ !== "undefined" && typeof $.os !== "undefined" && $.os.indexOf("Mac") !== -1); } catch (e) {}
            try { if (typeof system !== "undefined" && typeof system.callSystem === "function") { if (isMac) { system.callSystem("open -R \"" + fp + "\""); } else { system.callSystem("explorer /select,\"" + fp + "\""); } } } catch (e) {}
            return '{"ok":true}';
        } catch (e) { try { return '{"ok":false,"error":"' + _moEsc(e.toString()) + '"}'; } catch (e2) { return '{"ok":false,"error":"Unknown error"}'; } }
    };
    // openUrl: open http(s) URL in default browser.
    mediaotter.openUrl = function(url) {
        try {
            var u = String(url);
            if (u.indexOf("http") !== 0) { return '{"ok":false,"error":"Invalid URL"}'; }
            var isMac = false; try { isMac = (typeof $ !== "undefined" && typeof $.os !== "undefined" && $.os.indexOf("Mac") !== -1); } catch (e) {}
            try { if (typeof system !== "undefined" && typeof system.callSystem === "function") { if (isMac) { system.callSystem("open \"" + u + "\""); } else { system.callSystem("start \"\" \"" + u + "\""); } } } catch (e) {}
            return '{"ok":true}';
        } catch (e) { try { return '{"ok":false,"error":"' + _moEsc(e.toString()) + '"}'; } catch (e2) { return '{"ok":false,"error":"Unknown error"}'; } }
    };
    // getPref: always return "" (panel fallback).
    mediaotter.getPref = function(name) {
        try { return ""; } catch (e) { return ""; }
    };
}
