package com.gambiteer.mobile

import android.content.Context
import java.io.File
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The secret that lets only this app use its own servers. Android lets every app on the phone
 * connect to 127.0.0.1, so the backend (port 8000) and the coach (port 11434) want it on every
 * request: the WebView sends it as a cookie, and the backend passes it to the coach as a bearer
 * token (backend/app/security.py). It is made once per install and kept in the app's private
 * files, which other apps cannot read; both of the app's processes read it from there.
 */
object AccessKey {
    const val COOKIE = "gambiteer_key"
    private const val FILE = "access-key"

    @Volatile
    private var cached: String? = null

    fun get(context: Context): String {
        cached?.let { return it }
        val file = File(context.filesDir, FILE)
        if (!file.isFile) {
            val key = ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
            val temp = File.createTempFile(FILE, ".tmp", context.filesDir)
            temp.writeText(key)
            try {
                Files.move(temp.toPath(), file.toPath()) // refuses if the other process made it first
            } catch (_: FileAlreadyExistsException) {
                temp.delete()
            }
        }
        return file.readText().trim().also { cached = it }
    }

    /** Constant-time, so timing does not reveal how much of a guess was right. */
    fun matches(context: Context, given: String?): Boolean =
        given != null && MessageDigest.isEqual(given.toByteArray(), get(context).toByteArray())
}
