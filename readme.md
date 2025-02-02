# S3-Lock

As of [2024/08/20, S3 supports distributed locking through conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes/).

Conditional writes are done via [conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html). 

Specifically the [`If-Match` and `If-None-match`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html#API_PutObject_RequestSyntax) headers.

> If-Match \
Uploads the object only if the ETag (entity tag) value provided during the WRITE operation matches the ETag of the object in S3. If the ETag values do not match, the operation returns a 412 Precondition Failed error. 

> If-None-Match \
Uploads the object only if the object key name does not already exist in the bucket specified. Otherwise, Amazon S3 returns a 412 Precondition Failed error. 

The `If-Match` supports acquiring and releasing locks by overwriting a lock's status to a file. An entity can assume ownership if the  overwrite succeeds.

Clients can acquire a lock via writing `{locked: true}` to an existing file whose original value was `{locked: false}`. To ensure no clobbers occur the overwrite will only succeed if the ETag is the same at write time.

The `If-None-match` supports acquiring locks by writing a lock's status to a new file. An entity can assume ownership if the write succeeds.

Clients can acquire a lock via writing anything to a new file. To ensure no clobbers happen the write will only succeed if no file exists with such a name.  

Lock expiration can be achieved via fencing tokens either via monotonically increasing values within the lock files, alternatively the time stamps of the files could be utilized.

# Why?

- Assuming no lock contention, acquiring and then releasing a lock "only" costs $0.0009 USD 💸🤑💰
- Fast, releasing and acquiring locks "only" takes 10s of milliseconds 🏃💨💨
- Using strange/non idiomatic patterns for locking is a good idea 🔒🔓🔑

# Examples

```javascript
const lock = await locker.acquireLock({
    bucket,
    key,
    generateBody: async () => JSON.stringify({
        locked: true
    })
});

// do work

await lock.release(JSON.stringify({ locked: false }));
```