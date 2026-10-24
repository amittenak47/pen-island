package dev.lc.whiteboard.gallerysave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.net.Uri
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * Insert a PNG into the device Photos / Pictures library via MediaStore so it
 * shows up in the system gallery (not only an app-private Downloads folder),
 * and hand one to the system share sheet.
 *
 * Sharing cannot go through `navigator.share`: the WebView is served over
 * cleartext http so the LAN daemon is reachable, and the Web Share API is gated
 * on a secure context, so it is undefined. It is a native intent or nothing.
 */
@TauriPlugin
class GallerySavePlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class DocumentArgs {
        var path: String = ""
        var filename: String = "document.pdf"
        var mime: String = "application/pdf"
    }

    private fun exportFile(args: DocumentArgs): File {
        val file = File(args.path).canonicalFile
        val root = File(activity.cacheDir, "document-exports").canonicalFile
        if (file.parentFile != root || !file.isFile) throw IOException("Export file is unavailable")
        if (args.mime !in listOf("application/pdf", "application/epub+zip", "application/zip", "application/json")) throw IOException("Unsupported export format")
        return file
    }

    @Command
    fun save_document(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DocumentArgs::class.java)
            exportFile(args)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = args.mime
                putExtra(Intent.EXTRA_TITLE, args.filename)
            }
            startActivityForResult(invoke, intent, "documentResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Cannot save document") }
    }

    @ActivityCallback
    fun documentResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply { put("uri", "") }); return
        }
        val uri = result.data?.data
        if (uri == null) { invoke.reject("No save location returned"); return }
        // File-to-file copy: no whole-document base64 or byte array on the Java heap.
        Thread {
            try {
                val file = exportFile(invoke.parseArgs(DocumentArgs::class.java))
                activity.contentResolver.openOutputStream(uri, "w").use { output ->
                    if (output == null) throw IOException("Cannot write to selected location")
                    file.inputStream().use { input -> input.copyTo(output, 65536) }
                }
                invoke.resolve(JSObject().apply { put("uri", uri.toString()) })
            } catch (error: Exception) {
                runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
                invoke.reject(error.message ?: "Document save failed")
            }
        }.start()
    }

    @InvokeArg
    class SaveArgs {
        var png_base64: String = ""
        var filename: String = "pen-island-capture.png"
        var destination: String = "photos"
        var directory: String? = null
    }

    @Command
    fun save_png(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val bytes = try {
            Base64.decode(args.png_base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            invoke.reject("invalid png base64: ${error.message}")
            return
        }
        if (bytes.isEmpty()) {
            invoke.reject("empty png")
            return
        }

        try {
            val name = safeName(args.filename)
            val uri = if (args.destination == "folder") {
                insertDocument(bytes, name, args.directory)
            } else insertPng(bytes, name, args.destination == "downloads")
            invoke.resolve(JSObject().apply { put("uri", uri) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "gallery save failed")
        }
    }

    @Command
    fun pick_folder(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "folderResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Folder picker unavailable") }
    }

    @ActivityCallback
    fun folderResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply { put("uri", "") }); return
        }
        try {
            val data = result.data ?: throw IOException("No folder returned")
            val uri = data.data ?: throw IOException("No folder returned")
            val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            activity.contentResolver.takePersistableUriPermission(uri, flags)
            val document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
            val name = runCatching {
                activity.contentResolver.query(document, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null).use { cursor ->
                    if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
                }
            }.getOrNull() ?: uri.lastPathSegment ?: "folder"
            invoke.resolve(JSObject().apply { put("uri", uri.toString()); put("name", name) })
        } catch (error: Exception) { invoke.reject(error.message ?: "Folder permission failed") }
    }

    @InvokeArg
    class DocumentSourceArgs {
        var uri: String = ""
    }

    @Command
    fun list_folder(invoke: Invoke) {
        val args = invoke.parseArgs(DocumentSourceArgs::class.java)
        Thread {
            try {
                val tree = Uri.parse(args.uri)
                if (tree.scheme != "content" || !DocumentsContract.isTreeUri(tree)) throw IOException("Choose the folder again")
                val entries = JSONArray()
                listFolder(tree, DocumentsContract.getTreeDocumentId(tree), "", 0, entries)
                invoke.resolve(JSObject().apply { put("entries", entries) })
            } catch (error: Exception) { invoke.reject(error.message ?: "Cannot list folder") }
        }.start()
    }

    private fun listFolder(tree: Uri, parentId: String, relative: String, depth: Int, entries: JSONArray) {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        activity.contentResolver.query(children, null, null, null, null).use { cursor ->
            if (cursor == null) throw IOException("Folder is unavailable")
            val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val typeIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val nameIndex = cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            while (cursor.moveToNext()) {
                val name = cursor.getString(nameIndex) ?: continue
                if (name.startsWith(".")) continue
                val id = cursor.getString(idIndex) ?: continue
                val path = if (relative.isEmpty()) name else "$relative/$name"
                if (cursor.getString(typeIndex) == DocumentsContract.Document.MIME_TYPE_DIR) {
                    if (depth < 3) listFolder(tree, id, path, depth + 1, entries)
                } else {
                    val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex).takeIf { it >= 0 } else null
                    val modified = if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) cursor.getLong(modifiedIndex).takeIf { it >= 0 } else null
                    entries.put(JSObject().apply {
                        put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
                        put("name", name)
                        put("size", size ?: JSONObject.NULL)
                        put("modified", modified ?: JSONObject.NULL)
                        put("relative", path)
                    })
                }
            }
        }
    }

    @Command
    fun pick_document(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                // Match documentPickerAccept on Android: source files have too
                // many provider MIME aliases for a restricted list to work.
                type = "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "sourceDocumentResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Document picker unavailable") }
    }

    @ActivityCallback
    fun sourceDocumentResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply { put("uri", "") }); return
        }
        try {
            val uri = result.data?.data ?: throw IOException("No document returned")
            activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            val info = queryDocument(uri) ?: throw FileNotFoundException("Document is unavailable")
            info.put("uri", uri.toString())
            invoke.resolve(info)
        } catch (error: Exception) { invoke.reject(error.message ?: "Document permission failed") }
    }

    private fun queryDocument(uri: Uri): JSObject? {
        // A null projection lets providers omit unsupported columns, especially
        // last-modified, without failing the name and size query too.
        activity.contentResolver.query(uri, null, null, null, null).use { cursor ->
            if (cursor == null || !cursor.moveToFirst()) return null
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null
            val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex).takeIf { it >= 0 } else null
            val modified = if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) cursor.getLong(modifiedIndex).takeIf { it >= 0 } else null
            return JSObject().apply {
                put("name", name ?: "document")
                put("size", size ?: JSONObject.NULL)
                put("modified", modified ?: JSONObject.NULL)
            }
        }
    }

    @Command
    fun stat_document(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DocumentSourceArgs::class.java)
            val info = queryDocument(Uri.parse(args.uri))
            if (info == null) {
                invoke.resolve(JSObject().apply { put("exists", false) })
            } else {
                info.put("exists", true)
                invoke.resolve(info)
            }
        } catch (error: SecurityException) {
            invoke.resolve(JSObject().apply { put("exists", false) })
        } catch (error: FileNotFoundException) {
            invoke.resolve(JSObject().apply { put("exists", false) })
        } catch (error: IllegalArgumentException) {
            invoke.resolve(JSObject().apply { put("exists", false) })
        } catch (error: Exception) { invoke.reject(error.message ?: "Cannot check document") }
    }

    @Command
    fun read_document(invoke: Invoke) {
        val args = invoke.parseArgs(DocumentSourceArgs::class.java)
        Thread {
            try {
                val bytes = activity.contentResolver.openInputStream(Uri.parse(args.uri)).use { input ->
                    input?.readBytes() ?: throw FileNotFoundException("Document is unavailable")
                }
                invoke.resolve(JSObject().apply { put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)) })
            } catch (error: Exception) { invoke.reject(error.message ?: "Cannot read document") }
        }.start()
    }

    /*
     * A linked HTML file's folder, for the videos and pictures its page loads
     * from beside it.
     *
     * A file picked on its own carries a grant for that file only. Its folder
     * is reachable through a tree grant that covers it: one taken when the
     * folder was linked, or one asked for here.
     */

    @Command
    fun html_folder(invoke: Invoke) {
        val args = invoke.parseArgs(DocumentSourceArgs::class.java)
        Thread {
            try {
                val document = Uri.parse(args.uri)
                if (document.scheme != "content" || !DocumentsContract.isDocumentUri(activity, document)) {
                    invoke.resolve(JSObject()); return@Thread
                }
                val id = DocumentsContract.getDocumentId(document)
                val trees = activity.contentResolver.persistedUriPermissions
                    .filter { it.isReadPermission && it.uri.authority == document.authority && DocumentsContract.isTreeUri(it.uri) }
                val found = trees.firstNotNullOfOrNull { folderIn(it.uri, id) }
                invoke.resolve(found ?: JSObject().apply {
                    put("needsAccess", true)
                    parentPath(id)?.substringAfterLast('/')?.substringAfterLast(':')?.takeIf { it.isNotEmpty() }?.let { put("folder", it) }
                })
            } catch (error: Exception) { invoke.reject(error.message ?: "Cannot reach the page's folder") }
        }.start()
    }

    /** The folder holding document `id` inside `tree`, or null when the tree does not cover it. */
    private fun folderIn(tree: Uri, id: String): JSObject? {
        val treeId = DocumentsContract.getTreeDocumentId(tree)
        val found = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) runCatching {
            // Throws when the document is not inside the tree.
            DocumentsContract.findDocumentPath(activity.contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, id))
                ?.path?.takeIf { it.size >= 2 }?.let { it[it.size - 2] }
        }.getOrNull() else null
        val dir = found ?: parentPath(id)?.takeIf {
            it == treeId || it.startsWith(treeId.trimEnd('/') + "/") || (treeId.endsWith(":") && it.startsWith(treeId))
        } ?: return null
        return JSObject().apply { put("tree", tree.toString()); put("dir", dir) }
    }

    /** Parent of a path-like document id ("primary:Documents/read/page.html"), as external storage writes them. */
    private fun parentPath(id: String): String? = when {
        id.contains('/') -> id.substringBeforeLast('/')
        id.contains(':') && id.substringAfter(':').isNotEmpty() -> id.substringBefore(':') + ":"
        else -> null
    }

    @Command
    fun grant_html_folder(invoke: Invoke) {
        try {
            val document = Uri.parse(invoke.parseArgs(DocumentSourceArgs::class.java).uri)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                // Open on the file's own folder, so allowing it is one tap.
                val parent = runCatching { parentPath(DocumentsContract.getDocumentId(document)) }.getOrNull()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && parent != null && document.authority != null) {
                    putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(document.authority, parent))
                }
            }
            startActivityForResult(invoke, intent, "htmlFolderResult")
        } catch (error: Exception) { invoke.reject(error.message ?: "Folder picker unavailable") }
    }

    @ActivityCallback
    fun htmlFolderResult(invoke: Invoke, result: ActivityResult) {
        val tree = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || tree == null) { invoke.resolve(JSObject()); return }
        Thread {
            try {
                val document = Uri.parse(invoke.parseArgs(DocumentSourceArgs::class.java).uri)
                val resolver = activity.contentResolver
                val held = resolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }
                resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val found = folderIn(tree, DocumentsContract.getDocumentId(document))
                if (found == null) {
                    // A folder that does not hold the page: give back a grant taken just now.
                    if (!held) runCatching { resolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    invoke.resolve(JSObject().apply { put("wrongFolder", true) })
                } else invoke.resolve(found)
            } catch (error: Exception) { invoke.reject(error.message ?: "Folder permission failed") }
        }.start()
    }

    @InvokeArg
    class AssetArgs {
        var tree: String = ""
        var dir: String = ""
        var path: String = ""
    }

    /** Children found by name, per tree folder: a page asks for the same few files again and again. */
    private val assetIds = ConcurrentHashMap<String, String>()

    /**
     * Open `path` below the folder `dir` and hand its descriptor to Rust, which
     * owns and closes it and reads every range itself from then on. Bytes
     * through this bridge (base64, by way of the main thread) took a video
     * seconds per few megabytes.
     */
    @Command
    fun open_asset(invoke: Invoke) {
        val args = invoke.parseArgs(AssetArgs::class.java)
        Thread {
            try {
                val tree = Uri.parse(args.tree)
                val uri = assetUri(tree, args.dir, args.path, true)
                if (uri == null) { invoke.resolve(JSObject().apply { put("found", false) }); return@Thread }
                val descriptor = try { openAsset(uri) } catch (error: FileNotFoundException) {
                    // Renamed or replaced since it was found: look it up by name once more.
                    openAsset(assetUri(tree, args.dir, args.path, false) ?: throw error)
                }
                invoke.resolve(JSObject().apply { put("found", true); put("fd", descriptor.detachFd()) })
            } catch (error: FileNotFoundException) {
                invoke.resolve(JSObject().apply { put("found", false) })
            } catch (error: Exception) { invoke.reject(error.message ?: "Cannot open file") }
        }.start()
    }

    private fun openAsset(uri: Uri) =
        activity.contentResolver.openFileDescriptor(uri, "r") ?: throw FileNotFoundException("File is unavailable")

    /** Walks down from `dir` by name only, so nothing above the folder is reachable. */
    private fun assetUri(tree: Uri, dir: String, path: String, cached: Boolean): Uri? {
        var id = dir
        for (name in path.split('/')) {
            if (name.isEmpty() || name == "." || name == "..") return null
            val key = "$tree|$id|$name"
            id = (if (cached) assetIds[key] else null) ?: childId(tree, id, name)?.also { assetIds[key] = it } ?: return null
        }
        return DocumentsContract.buildDocumentUriUsingTree(tree, id)
    }

    private fun childId(tree: Uri, parent: String, name: String): String? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        activity.contentResolver.query(children, columns, null, null, null).use { cursor ->
            if (cursor == null) return null
            while (cursor.moveToNext()) if (cursor.getString(1) == name) return cursor.getString(0)
        }
        return null
    }

    private fun insertDocument(bytes: ByteArray, name: String, directory: String?): String {
        if (directory.isNullOrBlank()) throw IOException("Choose a capture folder in Settings")
        val tree = Uri.parse(directory)
        if (tree.scheme != "content" || !DocumentsContract.isTreeUri(tree)) throw IOException("Choose the folder again in Settings")
        val resolver = activity.contentResolver
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val uri = DocumentsContract.createDocument(resolver, parent, "image/png", name)
            ?: throw IOException("Cannot create capture; choose the folder again")
        try {
            resolver.openOutputStream(uri, "w").use { stream ->
                if (stream == null) throw IOException("Cannot write to selected folder")
                stream.write(bytes)
            }
        } catch (error: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, uri) }
            throw error
        }
        return uri.toString()
    }

    @InvokeArg
    class ShareArgs {
        var png_base64: String = ""
        var filename: String = "pen-island-capture.png"
    }

    /**
     * Hand a PNG to the system chooser.
     *
     * Written into the app cache and exposed through a `FileProvider` rather
     * than MediaStore: sharing should not also drop a copy in the gallery, and
     * a `content://` authority we own is the only URI another app is allowed to
     * read. Cached files are the OS's to reclaim.
     */
    @Command
    fun share_png(invoke: Invoke) {
        val args = invoke.parseArgs(ShareArgs::class.java)
        val bytes = try {
            Base64.decode(args.png_base64, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            invoke.reject("invalid png base64: ${error.message}")
            return
        }
        if (bytes.isEmpty()) {
            invoke.reject("empty png")
            return
        }

        try {
            val dir = File(activity.cacheDir, "shares").apply { mkdirs() }
            val file = File(dir, safeName(args.filename))
            file.writeBytes(bytes)

            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, null).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(chooser)
            invoke.resolve(JSObject().apply { put("uri", uri.toString()) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "share failed")
        }
    }

    private fun safeName(filename: String): String =
        filename
            .ifBlank { "pen-island-capture.png" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .let { if (it.lowercase().endsWith(".png")) it else "$it.png" }

    private fun insertPng(bytes: ByteArray, displayName: String, downloads: Boolean): String {
        if (downloads && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("Use a selected folder on this Android version")
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, (if (downloads) Environment.DIRECTORY_DOWNLOADS else Environment.DIRECTORY_PICTURES) + "/lc")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (downloads) MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        val uri = resolver.insert(collection, values)
            ?: throw IOException("MediaStore insert returned null")

        try {
        resolver.openOutputStream(uri).use { stream ->
            if (stream == null) throw IOException("cannot open MediaStore output stream")
            stream.write(bytes)
            stream.flush()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        }

        return uri.toString()
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }
}
