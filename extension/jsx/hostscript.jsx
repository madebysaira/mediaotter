// ExtendScript uses ECMAScript 3. Return JSON at every host boundary.
var mediaotter = {};
(function () {
  function esc(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t"); }
  function result(ok, message, itemName, timeline) {
    return '{"ok":' + (ok ? 'true' : 'false') + ',"error":"' + esc(ok ? '' : message) + '","itemName":"' + esc(itemName || '') + '","timelineAdded":' + (timeline ? 'true' : 'false') + ',"warning":"' + esc(ok ? message || '' : '') + '"}';
  }
  function isPremiere() { return typeof app !== "undefined" && app.name && String(app.name).indexOf("Premiere") !== -1; }
  function findItem(bin, filePath) {
    if (!bin || !bin.children) { return null; }
    for (var i = 0; i < bin.children.numItems; i++) {
      var item = bin.children[i];
      try { if (item.getMediaPath && new File(item.getMediaPath()).fsName === new File(filePath).fsName) { return item; } } catch (e) {}
    }
    return null;
  }
  mediaotter.ping = function () { return "MEDIAOTTER_HOST_READY_1.1.0"; };
  mediaotter.getProjectFolder = function () {
    try {
      if (!app || !app.project) { return ""; }
      var projectFile = isPremiere() ? (app.project.path ? new File(app.project.path) : null) : app.project.file;
      return projectFile && projectFile.parent ? projectFile.parent.fsName : "";
    } catch (e) { return ""; }
  };
  mediaotter.importFile = function (jsonStr) {
    try {
      var args = eval("(" + jsonStr + ")");
      if (!app || !app.project) { return result(false, "No project open"); }
      var file = new File(args.filePath);
      if (!file.exists) { return result(false, "File not found: " + args.filePath); }
      var binName = args.binName || "MediaOtter", item, folder, i;
      if (isPremiere()) {
        if (!app.project.rootItem) { return result(false, "No project open"); }
        var kids = app.project.rootItem.children;
        for (i = 0; i < kids.numItems; i++) { if (kids[i].type === 2 && kids[i].name === binName) { folder = kids[i]; break; } }
        if (!folder) { folder = app.project.rootItem.createBin(binName); }
        if (!folder) { return result(false, "Could not create download bin"); }
        item = findItem(folder, file.fsName);
        if (!item) {
          if (!app.project.importFiles([file.fsName], true, folder, false)) { return result(false, "Premiere rejected the import. Check media compatibility."); }
          item = findItem(folder, file.fsName);
          if (!item) { return result(false, "Import returned success but no project item was found"); }
        }
        if (args.addToTimeline) {
          var seq = app.project.activeSequence;
          if (!seq) { return result(true, "Imported into bin; open a sequence to add it to the timeline", item.name); }
          try {
            var inserted = seq.insertClip(item, seq.getPlayerPosition(), 0, 0);
            if (inserted === false) { return result(true, "Imported into bin; Premiere rejected timeline insertion", item.name); }
            return result(true, "", item.name, true);
          } catch (timelineError) { return result(true, "Imported into bin; timeline insertion failed: " + timelineError, item.name); }
        }
      } else {
        item = app.project.importFile(new ImportOptions(file));
        if (!item) { return result(false, "After Effects rejected the import"); }
        for (i = 1; i <= app.project.numItems; i++) { if (app.project.item(i) instanceof FolderItem && app.project.item(i).name === binName) { folder = app.project.item(i); break; } }
        if (!folder) { folder = app.project.items.addFolder(binName); }
        item.parentFolder = folder;
        if (args.addToComp) {
          var comp = app.project.activeItem;
          if (!comp || !(comp instanceof CompItem)) { return result(true, "Imported into folder; select a composition first", item.name); }
          try { comp.layers.add(item); return result(true, "", item.name, true); }
          catch (compError) { return result(true, "Composition insertion failed: " + compError, item.name); }
        }
      }
      return result(true, "", item.name);
    } catch (e) { return result(false, e.toString()); }
  };
}());
