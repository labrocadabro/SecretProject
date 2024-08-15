// Import required modules
const Adapter = require('../../model/adapter');
const cheerio = require('cheerio');
const { KoiiStorageClient } = require('@_koii/storage-task-sdk');
const Data = require('../../model/data');
const PCR = require('puppeteer-chromium-resolver');
const { namespaceWrapper } = require('@_koii/namespace-wrapper');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

/**
 * Twitter
 * @class
 * @extends Adapter
 * @description
 * Provides a searcher interface for the data gatherer nodes to use to interact with twitter
 */

class Twitter extends Adapter {
  constructor(credentials, db, maxRetry, comment) {
    super(credentials, maxRetry);
    this.credentials = credentials;
    this.db = new Data('db', []);
    this.db.initializeData();
    this.proofs = new Data('proofs', []);
    this.proofs.initializeData();
    this.cids = new Data('cids', []);
    this.cids.initializeData();
    this.commentsDB = new Data('comment', []);
    this.commentsDB.initializeData();
    this.toSearch = [];
    this.searchTerm = [];
    this.parsed = {};
    this.lastSessionCheck = null;
    this.sessionValid = false;
    this.browser = null;
    this.w3sKey = null;
    this.round = null;
    this.maxRetry = maxRetry;
    this.comment = comment;
  }

  /**
   * checkSession
   * @returns {Promise<boolean>}
   * @description
   * 1. Check if the session is still valid
   * 2. If the session is still valid, return true
   * 3. If the session is not valid, check if the last session check was more than 1 minute ago
   * 4. If the last session check was more than 1 minute ago, negotiate a new session
   */
  checkSession = async () => {
    if (this.sessionValid) {
      return true;
    } else if (Date.now() - this.lastSessionCheck > 50000) {
      await this.negotiateSession();
      return true;
    } else {
      return false;
    }
  };

  /**
   * negotiateSession
   * @returns {Promise<void>}
   * @description
   * 1. Get the path to the Chromium executable
   * 2. Launch a new browser instance
   * 3. Open a new page
   * 4. Set the viewport size
   * 5. Queue twitterLogin()
   */
  negotiateSession = async () => {
    try {
      if (this.browser) {
        await this.browser.close();
        console.log('Old browser closed');
      }
      const options = {};
      const userDataDir = path.join(
        __dirname,
        'puppeteer_cache_AIC_twitter_archive',
      );
      const stats = await PCR(options);
      console.log(
        '*****************************************CALLED PURCHROMIUM RESOLVER*****************************************',
      );
      this.browser = await stats.puppeteer.launch({
        executablePath: stats.executablePath,
        userDataDir: userDataDir,
        headless: false,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        args: [
          '--aggressive-cache-discard',
          '--disable-cache',
          '--disable-application-cache',
          '--disable-offline-load-stale-cache',
          '--disable-gpu-shader-disk-cache',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
        ],
      });
      console.log('Step: Open new page');
      this.page = await this.browser.newPage();
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      );
      await this.page.waitForTimeout(await this.randomDelay(3000));
      // await this.page.setViewport({ width: 1920, height: 1080 });
      const screenWidth = await this.page.evaluate(() => window.screen.width);
      const screenHeight = await this.page.evaluate(() => window.screen.height);
      await this.page.setViewport({ width: screenWidth, height: screenHeight });
      await this.page.waitForTimeout(await this.randomDelay(3000));

      await this.twitterLogin();
      return true;
    } catch (e) {
      console.log('Error negotiating session', e);
      return false;
    }
  };

  /**
   * twitterLogin
   * @returns {Promise<void>}
   * @description
   * 1. Go to x.com
   * 2. Go to login page
   * 3. Fill in username
   * 4. Fill in password
   * 5. Click login
   * 6. Wait for login to complete
   * 7. Check if login was successful
   * 8. If login was successful, return true
   * 9. If login was unsuccessful, return false
   * 10. If login was unsuccessful, try again
   */
  twitterLogin = async () => {
    let currentAttempt = 0;
    const cookieLoginSuccess = await this.tryLoginWithCookies();
    if (cookieLoginSuccess) {
      this.sessionValid = true;
      return this.sessionValid;
    }
    while (currentAttempt < this.maxRetry && !this.sessionValid) {
      try {
        console.log(currentAttempt, this.maxRetry);
        console.log('Step: Go to login page');
        await this.page.goto('https://x.com/i/flow/login', {
          timeout: await this.randomDelay(60000),
          waitUntil: 'networkidle0',
        });
        let basePath = '';
        basePath = await namespaceWrapper.getBasePath();
        console.log('Waiting for login page to load');

        // Retrieve the outer HTML of the body element
        const bodyHTML = await this.page.evaluate(
          () => document.body.outerHTML,
        );

        // Write the HTML to a file
        fs.writeFileSync(`${basePath}/bodyHTML.html`, bodyHTML);

        await this.page.waitForSelector('input', {
          timeout: await this.randomDelay(60000),
        });
        // Select the div element by its aria-labelledby attribute
        const usernameHTML = await this.page.$eval('input', el => el.outerHTML);

        // Use fs module to write the HTML to a file
        fs.writeFileSync(`${basePath}/usernameHTML.html`, usernameHTML);

        await this.page.waitForSelector('input[name="text"]', {
          timeout: await this.randomDelay(60000),
        });

        console.log('Step: Fill in username');
        console.log(this.credentials.username);

        await this.page.type('input[name="text"]', this.credentials.username);
        await this.page.keyboard.press('Enter');
        await new Promise(resolve => setTimeout(resolve, 10000));

        const twitter_verify = await this.page
          .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
            timeout: await this.randomDelay(5000),
            visible: true,
          })
          .then(() => true)
          .catch(() => false);

        if (twitter_verify) {
          const verifyURL = await this.page.url();
          console.log('Twitter verify needed, trying phone number');
          console.log('Step: Fill in phone number');
          await this.page.type(
            'input[data-testid="ocfEnterTextTextInput"]',
            this.credentials.phone,
          );
          await this.page.keyboard.press('Enter');

          // add delay
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Select the div element by its aria-labelledby attribute
        const passwordHTML = await this.page.$$eval('input', elements =>
          elements.map(el => el.outerHTML).join('\n'),
        );

        // Use fs module to write the HTML to a file
        fs.writeFileSync(`${basePath}/passwordHTML.html`, passwordHTML);

        await this.page.waitForSelector('input[name="password"]');
        console.log('Step: Fill in password');
        await this.page.type(
          'input[name="password"]',
          this.credentials.password,
        );
        console.log('Step: Click login button');
        await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(await this.randomDelay(3000));
        if (!(await this.checkLogin())) {
          console.log('Password is incorrect or email verification needed.');
          await this.page.waitForTimeout(await this.randomDelay(5000));
          this.sessionValid = false;
          process.exit(1);
        } else if (await this.isEmailVerificationRequired(this.page)) {
          console.log('Email verification required.');
          this.sessionValid = false;
          await this.page.waitForTimeout(await this.randomDelay(10000));
          process.exit(1);
        } else {
          console.log('Password is correct.');
          this.page.waitForNavigation({ waitUntil: 'load' });
          await this.page.waitForTimeout(await this.randomDelay(10000));

          this.sessionValid = true;
          this.lastSessionCheck = Date.now();

          console.log('Step: Login successful');

          // Extract cookies
          const cookies = await this.page.cookies();
          // console.log('cookies', cookies);
          // Save cookies to database
          await this.saveCookiesToDB(cookies);
        }
        return this.sessionValid;
      } catch (e) {
        console.log(
          `Error logging in, retrying ${currentAttempt + 1} of ${
            this.maxRetry
          }`,
          e,
        );
        currentAttempt++;

        if (currentAttempt === this.maxRetry) {
          console.log('Max retry reached, exiting');
          process.exit(1);
        }
      }
    }
  };

  tryLoginWithCookies = async () => {
    const cookies = await this.db.getItem({ id: 'cookies' });
    if (cookies && cookies.data && cookies.data.length > 0) {
      // set the cookies
      await this.page.setCookie(...cookies);
      await this.page.goto('https://x.com/home');
      await this.page.waitForTimeout(await this.randomDelay(5000));

      const isLoggedIn =
        (await this.page.url()) !==
          'https://x.com/i/flow/login?redirect_after_login=%2Fhome' &&
        !(await this.page.url()).includes('https://x.com/?logout=');

      if (isLoggedIn) {
        console.log('Logged in using existing cookies');
        console.log('Updating last session check');
        const cookies = await this.page.cookies();
        this.saveCookiesToDB(cookies);
        this.sessionValid = true;
        // Optionally, refresh or validate cookies here
      } else {
        console.log('No valid cookies found, proceeding with manual login');
        this.sessionValid = false;
      }
      return this.sessionValid;
    } else {
      console.log('No cookies found');
      return false;
    }
  };

  createNewPage = async () => {
    let currentAttempt = 0;
    while (currentAttempt < 3) {
      try {
        const newPage = await this.browser.newPage();
        return newPage;
      } catch (e) {
        console.log('Error creating new page', e);
        currentAttempt++;
      }
    }
    return null;
  };

  checkLogin = async () => {
    const newPage = await this.browser.newPage();
    await newPage.waitForTimeout(await this.randomDelay(8000));
    await newPage.goto('https://x.com/home');
    await newPage.waitForTimeout(await this.randomDelay(5000));
    // Replace the selector with a Twitter-specific element that indicates a logged-in state
    const isLoggedIn =
      (await newPage.url()) !==
        'https://x.com/i/flow/login?redirect_after_login=%2Fhome' &&
      !(await newPage.url()).includes('https://x.com/?logout=');
    if (isLoggedIn) {
      console.log('Logged in using existing cookies');
      console.log('Updating last session check');
      this.sessionValid = true;
    } else {
      console.log('No valid cookies found, proceeding with manual login');
      this.sessionValid = false;
    }
    await newPage.waitForTimeout(await this.randomDelay(3000));
    await newPage.close();
    await newPage.waitForTimeout(await this.randomDelay(3000));
    return this.sessionValid;
  };

  saveCookiesToDB = async cookies => {
    try {
      const data = await this.db.getItem({ id: 'cookies' });
      if (data && data.data) {
        await this.db.updateCookie({ id: 'cookies', data: cookies });
      } else {
        await this.db.create({ id: 'cookies', data: cookies });
      }
    } catch (e) {
      console.log('Error saving cookies to database', e);
    }
  };

  isEmailVerificationRequired = async page => {
    // Wait for some time to allow the page to load the required elements
    await page.waitForTimeout(await this.randomDelay(5000));

    // Check if the specific text is present on the page
    const textContent = await this.page.evaluate(
      () => document.body.textContent,
    );
    return textContent.includes(
      'Verify your identity by entering the email address associated with your X account.',
    );
  };

  /**
   * getSubmissionCID
   * @param {string} round - the round to get the submission cid for
   * @returns {string} - the cid of the submission
   * @description - this function should return the cid of the submission for the given round
   * if the submission has not been uploaded yet, it should upload it and return the cid
   */
  getSubmissionCID = async round => {
    if (this.proofs) {
      // we need to upload proofs for that round and then store the cid
      const data = await this.cids.getList({ round: round });
      console.log(`got cids list for round ${round}`);

      if (data && data.length === 0) {
        console.log('No cids found for round ' + round);
        return null;
      } else {
        let proof_cid;
        let path = `dataList.json`;
        let basePath = '';
        try {
          basePath = await namespaceWrapper.getBasePath();
          fs.writeFileSync(`${basePath}/${path}`, JSON.stringify(data));
        } catch (err) {
          console.log(err);
        }
        try {
          const client = new KoiiStorageClient(undefined, undefined, false);
          const userStaking = await namespaceWrapper.getSubmitterAccount();
          console.log(`Uploading ${basePath}/${path}`);
          const fileUploadResponse = await client.uploadFile(
            `${basePath}/${path}`,
            userStaking,
          );
          console.log(`Uploaded ${basePath}/${path}`);
          const cid = fileUploadResponse.cid;
          proof_cid = cid;
          await this.proofs.create({
            id: 'proof:' + round,
            proof_round: round,
            proof_cid: proof_cid,
          });

          console.log('returning proof cid for submission', proof_cid);
          return proof_cid;
        } catch (error) {
          if (error.message === 'Invalid Task ID') {
            console.error('Error: Invalid Task ID');
          } else {
            console.error('An unexpected error occurred:', error);
          }
        }
      }
    } else {
      throw new Error('No proofs database provided');
    }
  };

  humanType = async (page, selector, text) => {
    for (const char of text) {
      await page.type(selector, char);
      const typingSpeed = Math.random() * 100 + 30;
      await page.waitForTimeout(typingSpeed);

      // Randomly add longer pauses to mimic thinking
      if (Math.random() < 0.1) {
        const thinkingPause = Math.random() * 1000 + 200;
        await page.waitForTimeout(thinkingPause);
      }
    }
    console.log(`Finished typing. Waiting for additional delay`);
  };

  // clean text
  cleanText = async text => {
    return text.replace(/\s+/g, '').trim();
  };

  postCommentAndCheckExistence = async (url, commentText) => {
    const newPage = await this.browser.newPage();
    await newPage.goto(url);
    await newPage.waitForTimeout(await this.randomDelay(8000));

    // Extract existing comments and check if the comment exists
    let hasMoreComments = true;
    commentText = await this.cleanText(commentText);

    while (hasMoreComments) {
      await newPage.waitForTimeout(await this.randomDelay(3000));
      const existingComments = await newPage.evaluate(
        async cleanTextStr => {
          // Reconstruct the cleanText function inside the browser context
          const cleanText = new Function('return ' + cleanTextStr)();
          const tweetElements = Array.from(
            document.querySelectorAll('article[data-testid="tweet"]'),
          );
          const comments = [];

          // Process all tweet elements asynchronously
          await Promise.all(
            tweetElements.map(async tweetElement => {
              const textElement = tweetElement.querySelector('div[lang]');
              let textContent = '';

              // set timeout
              await new Promise(resolve => setTimeout(resolve, 2000));

              if (textElement && textElement.childNodes) {
                textElement.childNodes.forEach(node => {
                  let content = '';

                  if (node.nodeName === 'IMG') {
                    content = node.alt || '';
                  } else {
                    content = node.innerText || node.textContent;
                  }

                  // Check if content is not null, undefined, or empty
                  if (content) {
                    textContent += content;
                  }
                });
              }

              if (textContent) {
                try {
                  const waitCleanText = await cleanText(textContent);
                  console.log(waitCleanText);
                  const getComments = waitCleanText;
                  comments.push(getComments);
                } catch (error) {
                  console.error('Error processing comment:', error);
                }
              }
            }),
          );

          return comments;
        },

        this.cleanText.toString(), // Pass the cleanText function as a string
      );

      // Check if the comment already exists
      const found = existingComments.some(item =>
        item.toLowerCase().includes(commentText.toLowerCase()),
      );

      if (found) {
        console.log('Comment already exists.');
        await newPage.waitForTimeout(await this.randomDelay(3000));
        await newPage.close();
        return true;
      }

      // Scroll down to load more comments
      const previousScrollHeight = await newPage.evaluate(
        () => document.body.scrollHeight,
      );
      await newPage.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await newPage.waitForTimeout(await this.randomDelay(4000));

      const currentScrollHeight = await newPage.evaluate(
        () => document.body.scrollHeight,
      );
      hasMoreComments = currentScrollHeight > previousScrollHeight;
    }

    console.log('Comment does not exist.');
    await newPage.waitForTimeout(await this.randomDelay(3000));
    await newPage.close();
    return false;
  };

  getTheCommentDetails = async (url, commentText) => {
    const commentPage = await this.browser.newPage();
    await commentPage.goto(url);
    await commentPage.waitForTimeout(await this.randomDelay(8000));

    // Extract existing comments and check if the comment exists
    let hasMoreComments = true;
    let trimCommentText = await this.cleanText(commentText);
    while (hasMoreComments) {
      await commentPage.waitForTimeout(await this.randomDelay(3000));

      const commentDetails = await commentPage.evaluate(
        async cleanTextStr => {
          const cleanText = new Function('return ' + cleanTextStr)();
          const tweetElements = Array.from(
            document.querySelectorAll('article[data-testid="tweet"]'),
          );

          const details = [];

          await Promise.all(
            tweetElements.map(async tweetElement => {
              let commentId = null;
              let username = null;
              let postTime = null;

              const textElement = tweetElement.querySelector('div[lang]');
              let textContent = '';
              if (textElement && textElement.childNodes) {
                textElement.childNodes.forEach(node => {
                  let content = '';

                  if (node.nodeName === 'IMG') {
                    content = node.alt || '';
                  } else {
                    content = node.innerText || node.textContent;
                  }

                  // Check if content is not null, undefined, or empty
                  if (content) {
                    textContent += content;
                  }
                });
              }

              const anchorElements = tweetElement.querySelectorAll(
                'div[data-testid="User-Name"]',
              );
              anchorElements.forEach(anchorElement => {
                const getAnchorTags = anchorElement.querySelectorAll('a');

                for (let index = 0; index < getAnchorTags.length; index++) {
                  const element = getAnchorTags[getAnchorTags.length - 1];

                  // Extract username
                  const urlMatch = element.href.match(
                    /^https?:\/\/[^\/]+\/([^\/]+)\/status\/(\d+)$/,
                  );
                  username = urlMatch ? urlMatch[1] : null;
                  commentId = urlMatch ? urlMatch[2] : null;

                  // Extract post time
                  const timeElement = element.querySelector('time');
                  postTime = timeElement
                    ? timeElement.getAttribute('datetime')
                    : null;

                  break;
                }
              });
              await new Promise(resolve => setTimeout(resolve, 10000));

              if (textContent) {
                try {
                  const getComments = await cleanText(textContent);
                  details.push({ commentId, getComments, username, postTime });
                } catch (error) {
                  console.error('Error processing comment:', error);
                }
              }
            }),
          );

          return details;
        },
        this.cleanText.toString(),
        trimCommentText,
      );

      // Check if the comment already exists
      const foundItem = commentDetails.find(item =>
        item.getComments.toLowerCase().includes(trimCommentText.toLowerCase()),
      );

      console.log(foundItem);

      if (foundItem) {
        // Convert foundItem to a boolean to check if it exists
        const found = !!foundItem;

        if (found) {
          console.log('Comment found.');
          const timestamp = await this.convertToTimestamp(foundItem.postTime);
          foundItem.postTime = timestamp;
          foundItem.getComments = commentText;
          await commentPage.waitForTimeout(await this.randomDelay(3000));
          await commentPage.close();
          return foundItem;
        }
      }

      // Scroll down to load more comments
      const previousScrollHeight = await commentPage.evaluate(
        () => document.body.scrollHeight,
      );
      await commentPage.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await commentPage.waitForTimeout(await this.randomDelay(3000));

      const currentScrollHeight = await commentPage.evaluate(
        () => document.body.scrollHeight,
      );
      hasMoreComments = currentScrollHeight > previousScrollHeight;
    }

    console.log('Comment does not exist.');
    await commentPage.waitForTimeout(await this.randomDelay(3000));
    await commentPage.close();
    return {};
  };

  /**
   * parseItem
   * @param {string} url - the url of the item to parse
   * @param {object} query - the query object to use for parsing
   * @returns {object} - the parsed item
   * @description - this function should parse the item at the given url and return the parsed item data
   *               according to the query object and for use in either search() or validate()
   */
  parseItem = async (item, comment, url) => {
    if (this.sessionValid == false) {
      await this.negotiateSession();
    }
    try {
      const $ = cheerio.load(item);
      let data = {};

      const articles = $('article[data-testid="tweet"]').toArray();
      const el = articles[0];
      const tweetUrl = $('a[href*="/status/"]').attr('href');
      const tweetId = tweetUrl.split('/').pop();

      // get the other info about the article
      const screen_name = $(el).find('a[tabindex="-1"]').text();
      const allText = $(el).find('a[role="link"]').text();
      const user_name = allText.split('@')[0];
      const user_url =
        'https://x.com' + $(el).find('a[role="link"]').attr('href');
      const user_img = $(el).find('img[draggable="true"]').attr('src');
      const tweet_text = $(el)
        .find('div[data-testid="tweetText"]')
        .first()
        .text();
      const outerMediaElements = $(el).find('div[data-testid="tweetText"] a');
      const outer_media_urls = [];
      const outer_media_short_urls = [];
      outerMediaElements.each(function () {
        const fullURL = $(this).attr('href');
        const shortURL = $(this).text().replace(/\s/g, '');

        // Ignore URLs containing "/search?q=" or "x.com"
        if (
          fullURL &&
          !fullURL.includes('/search?q=') &&
          !fullURL.includes('twitter.com') &&
          !fullURL.includes('x.com') &&
          !fullURL.includes('/hashtag/')
        ) {
          outer_media_urls.push(fullURL);
          outer_media_short_urls.push(shortURL);
        }
      });
      const timeRaw = $(el).find('time').attr('datetime');
      const time = await this.convertToTimestamp(timeRaw);
      const tweet_record = $(el).find(
        'span[data-testid="app-text-transition-container"]',
      );
      const commentCount = tweet_record.eq(0).text();
      const likeCount = tweet_record.eq(1).text();
      const shareCount = tweet_record.eq(2).text();
      const viewCount = tweet_record.eq(3).text();
      // this is for the hash and salt
      const tweets_content = tweet_text.replace(/\n/g, '<br>');
      const round = namespaceWrapper.getRound();
      const originData = tweets_content + round;
      const saltRounds = 10;
      const salt = bcrypt.genSaltSync(saltRounds);
      const hash = bcrypt.hashSync(originData, salt);

      // wait for sometime
      await this.page.waitForTimeout(await this.randomDelay(4000));
      // open new page
      const commentPage = await this.browser.newPage();
      const getNewPageUrl = `${url}/status/${tweetId}`;
      await commentPage.goto(getNewPageUrl);
      await this.page.waitForTimeout(await this.randomDelay(8000));

      // check if already comments or not
      const getBoolComments = await this.postCommentAndCheckExistence(
        getNewPageUrl,
        comment,
      );
      if (getBoolComments) {
        await commentPage.close();
        return data;
      }

      // write a comment and post
      await commentPage.waitForTimeout(await this.randomDelay(3000));
      const writeSelector =
        'div[data-testid="tweetTextarea_0RichTextInputContainer"]';

      await commentPage.evaluate(writeSelector => {
        const element = document.querySelector(writeSelector);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, writeSelector);
      await commentPage.waitForTimeout(await this.randomDelay(3000));
      await commentPage.waitForSelector(writeSelector);
      await commentPage.click(writeSelector);
      await commentPage.waitForTimeout(await this.randomDelay(6000));
      await this.humanType(commentPage, writeSelector, comment);
      await commentPage.waitForTimeout(await this.randomDelay(8000));
      // button for post the comment
      await commentPage.evaluate(async () => {
        const button = document.querySelector(
          'button[data-testid="tweetButtonInline"]',
        );
        if (button && !button.disabled) {
          await button.click();
        } else {
          console.log('cant click the button');
        }
      });
      await commentPage.waitForTimeout(await this.randomDelay(6000));

      // check if comment is posted or not if posted then get the details
      const getCommentDetailsObject = await this.getTheCommentDetails(
        getNewPageUrl,
        comment,
      );

      // close the comment page
      await commentPage.waitForTimeout(await this.randomDelay(8000));
      await commentPage.close();
      await commentPage.waitForTimeout(await this.randomDelay(8000));

      if (
        !getCommentDetailsObject ||
        Object.keys(getCommentDetailsObject).length === 0
      ) {
        return data;
      }

      if (screen_name && tweet_text) {
        data = {
          user_name: user_name,
          screen_name: screen_name,
          user_url: user_url,
          user_img: user_img,
          tweets_id: tweetId,
          tweets_content: tweets_content,
          time_post: time,
          time_read: Date.now(),
          comment: commentCount,
          like: likeCount,
          share: shareCount,
          view: viewCount,
          outer_media_url: outer_media_urls,
          outer_media_short_url: outer_media_short_urls,
          keyword: this.searchTerm,
          hash: hash,
          commentDetails: getCommentDetailsObject,
        };
      }
      return data;
    } catch (e) {
      console.log(
        'Filtering advertisement tweets; continuing to the next item :: ',
        e,
      );
    }
  };

  convertToTimestamp = async dateString => {
    const date = new Date(dateString);
    return Math.floor(date.getTime() / 1000);
  };

  /**
   * search
   * @param {string} query
   * @returns {Promise<string[]>}
   * @description searchs the queue of known links
   */
  search = async query => {
    console.log('valid? ', this.sessionValid);
    if (this.sessionValid == true) {
      this.searchTerm = query.searchTerm;
      this.round = query.round;
      this.comment = query.comment;
      await this.fetchList(query.query, query.round, query.comment);
    } else {
      await this.negotiateSession();
    }
  };

  // get the current timestamp
  getCurrentTimestamp = async () => {
    const currentDate = new Date();
    const millisecondsTimestamp = currentDate.getTime();
    const currentTimeStamp = Math.floor(millisecondsTimestamp / 1000);
    return currentTimeStamp;
  };

  checkCommentTimestamp = (currentTimeStamp, Timestamp) => {
    try {
      const HOURS_OPTIONS = [21, 22, 23, 24, 25, 26, 27];
      const getRandomHours = options =>
        options[Math.floor(Math.random() * options.length)];
      const HOURS_IN_MS = 60 * 60 * 1000;

      const randomHours = getRandomHours(HOURS_OPTIONS);
      const rangeInMilliseconds = randomHours * HOURS_IN_MS;

      if (currentTimeStamp - Timestamp < rangeInMilliseconds) {
        console.log(`Timestamp is less than ${randomHours} hours old`);
        return false;
      }
      return true;
    } catch (error) {
      console.log(`Some error in the checkCommentTimestamp :: `, error);
      return false;
    }
  };

  /**
   * fetchList
   * @param {string} url
   * @returns {Promise<string[]>}
   * @description Fetches a list of links from a given url
   */
  fetchList = async (url, round, comment) => {
    try {
      console.log('fetching list for ', url);
      // Go to the hashtag page
      await this.page.waitForTimeout(await this.randomDelay(6000));
      // await this.page.setViewport({ width: 1024, height: 4000 });
      const screenWidth = await this.page.evaluate(() => window.screen.width);
      const screenHeight = await this.page.evaluate(() => window.screen.height);
      await this.page.setViewport({ width: screenWidth, height: screenHeight });
      await this.page.goto(url);
      await this.page.waitForTimeout(await this.randomDelay(8000));

      let i = 0;
      while (true) {
        i++;

        // error message
        const errorMessage = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('div[dir="ltr"]');
          for (let element of elements) {
            console.log(element.textContent);
            if (
              element.textContent === 'Something went wrong. Try reloading.'
            ) {
              return true;
            }
          }
          return false;
        });

        // get the articles
        const items = await this.page.evaluate(() => {
          const elements = document.querySelectorAll(
            'article[aria-labelledby]',
          );
          return Array.from(elements).map(element => element.outerHTML);
        });

        await this.page.waitForTimeout(await this.randomDelay(5000));
        console.log('items :: ', items.length);

        // loop the articles
        for (const item of items) {
          await new Promise(resolve => setTimeout(resolve, 1000));

          try {
            const getCommentTimeStamp = await this.commentsDB.getTimestamp(
              comment,
            );
            console.log('getCommentTimeStamp :: ', getCommentTimeStamp);

            if (getCommentTimeStamp) {
              // get the timestamp
              const currentTimeStamp = await this.getCurrentTimestamp();
              // check the timestamp if it is less than specific hours
              const getCommentBool = this.checkCommentTimestamp(
                currentTimeStamp,
                getCommentTimeStamp,
              );

              if (!getCommentBool) {
                break;
              }
            }

            let data = await this.parseItem(item, comment, url);
            if (data.tweets_id) {
              let checkItem = {
                id: data.tweets_id,
              };
              const existingItem = await this.db.getItem(checkItem);
              if (!existingItem) {
                this.cids.create({
                  id: data.tweets_id,
                  round: round,
                  data: data,
                });

                // get the current timeStamp
                const currentTimeStamp = await this.getCurrentTimestamp();
                // store comments timestamp in current timestamp
                this.commentsDB.createTimestamp(comment, currentTimeStamp);
              }
            }
          } catch (e) {
            console.log(
              'Filtering advertisement tweets; continuing to the next item.',
              e,
            );
          }
        }

        try {
          let dataLength = (await this.cids.getList({ round: round })).length;
          if (dataLength > 120 || i > 4) {
            console.log('reach maixmum data per round. Closed old browser');
            this.browser.close();
            break;
          }
          // Scroll the page for next batch of elements
          await this.scrollPage(this.page);

          // Optional: wait for a moment to allow new elements to load
          await this.page.waitForTimeout(await this.randomDelay(5000));

          // Refetch the elements after scrolling
          await this.page.evaluate(() => {
            return document.querySelectorAll('article[aria-labelledby]');
          });
        } catch (e) {
          console.log('round check error', e);
        }

        // If the error message is found, wait for 2 minutes, refresh the page, and continue
        if (errorMessage) {
          console.log('Rate limit reach, waiting for next round...');
          this.browser.close();
          break;
        }
      }
      return;
    } catch (e) {
      console.log('Last round fetching list stop', e);
      return;
    }
  };

  compareHash = async (data, saltRounds) => {
    const round = namespaceWrapper.getRound();
    const dataToCompare = data.data.tweets_content + round; // + data.data.tweets_id;
    console.log(dataToCompare);
    const salt = bcrypt.genSaltSync(saltRounds);
    const hash = bcrypt.hashSync(dataToCompare, salt);
    console.log(hash);
    const hashCompare = bcrypt.compareSync(dataToCompare, hash);
    console.log(hashCompare);
    const hashCompareWrong = bcrypt.compareSync(data.data.tweets_id, hash);
    console.log(hashCompareWrong);
  };

  /**
   * retrieveItem derived from fetchList
   * @param {*} url
   * @param {*} item
   * @returns
   */
  retrieveItem = async (verify_page, tweetid, comment, url) => {
    console.log(verify_page);
    console.log(tweetid);
    console.log(comment);
    console.log(url);
    try {
      let i = 0;
      while (true) {
        i++;
        // // Check if the error message is present on the page inside an article element
        const errorMessage = await verify_page.evaluate(() => {
          const elements = document.querySelectorAll('div[dir="ltr"]');
          for (let element of elements) {
            if (
              element.textContent === 'Something went wrong. Try reloading.'
            ) {
              return true;
            }
          }
          return false;
        });

        // Archive the tweets
        const items = await verify_page.evaluate(() => {
          const elements = document.querySelectorAll(
            'article[aria-labelledby]',
          );
          return Array.from(elements).map(element => element.outerHTML);
        });

        let temp = null;
        // Reason why many tweets: The given link might contain a main tweet and its comments, and the input task id might be one of the comments task id
        for (const item of items) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Adds a 1-second delay
          try {
            let data = await this.parseItem(item, comment, url);
            console.log(data);
            console.log(data.tweets_id);
            console.log(tweetid);
            if (data.tweets_id == tweetid) {
              return data;
            } else {
              console.log('tweets id diff, continue');
            }
            if (data.tweets_id == '1') {
              temp = data;
            }
          } catch (e) {
            console.log(e);
            console.log(
              'Filtering advertisement tweets; continuing to the next item.',
            );
          }
        }

        return temp;
      }
    } catch (e) {
      console.log('Last round fetching list stop', e);
      return;
    }
  };

  verify = async (tweetid, inputitem, round) => {
    console.log('----Input Item Below -----');
    console.log(inputitem);
    console.log('----Input Item Above -----');
    try {
      const options = {};
      const userAuditDir = path.join(
        __dirname,
        'puppeteer_cache_koii_twitter_archive_audit',
      );
      const stats = await PCR(options);
      let auditBrowser = await stats.puppeteer.launch({
        executablePath: stats.executablePath,
        userDataDir: userAuditDir,
        headless: false,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        args: [
          '--aggressive-cache-discard',
          '--disable-cache',
          '--disable-application-cache',
          '--disable-offline-load-stale-cache',
          '--disable-gpu-shader-disk-cache',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
        ],
      });
      const url = `${inputitem.user_url}/status/${tweetid}`;
      const verify_page = await auditBrowser.newPage();
      await verify_page.goto(url, { timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 5000));
      let confirmed_no_tweet = false;
      await verify_page.evaluate(() => {
        if (document.querySelector('[data-testid="error-detail"]')) {
          console.log('Error detail found');
          confirmed_no_tweet = true;
        }
      });

      if (confirmed_no_tweet) {
        return false; // Return false if error-detail is found
      }
      console.log('Retrieve item for', url);
      const result = await this.retrieveItem(
        verify_page,
        tweetid,
        inputitem.commentDetails.getComments,
        inputitem.user_url,
      );
      if (result) {
        if (result.tweets_content != inputitem.tweets_content) {
          console.log(
            'Content not match',
            result.tweets_content,
            inputitem.tweets_content,
          );
          auditBrowser.close();
          return false;
        }
        if (result.time_read - inputitem.time_read > 3600000 * 15) {
          console.log(
            'Time read difference too big',
            result.time_read,
            inputitem.time_read,
          );
          auditBrowser.close();
          return false;
        }
        const dataToCompare = result.tweets_content + round;

        const hashCompare = bcrypt.compareSync(dataToCompare, inputitem.hash);
        if (hashCompare == false) {
          console.log(
            'Hash Verification Failed',
            dataToCompare,
            inputitem.hash,
          );
          auditBrowser.close();
          return false;
        }
        auditBrowser.close();
        return true;
      }
      // Result does not exist
      console.log('Result does not exist. ');
      auditBrowser.close();
      return false;
    } catch (e) {
      console.log('Error fetching single item', e);
      return false; // Return false in case of an exception
    }
  };

  scrollPage = async page => {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(5000); // Adjust the timeout as necessary
  };

  /**
   * processLinks
   * @param {string[]} links
   * @returns {Promise<void>}
   * @description Processes a list of links
   * @todo Implement this function
   * @todo Implement a way to queue links
   */
  processLinks = async links => {
    links.forEach(link => {});
  };

  randomDelay = async delayTime => {
    const delay =
      Math.floor(Math.random() * (delayTime - 2000 + 1)) + (delayTime - 2000);
    return delay;
  };

  /**
   * stop
   * @returns {Promise<boolean>}
   * @description Stops the searcher
   */
  stop = async () => {
    if (this.browser) {
      await this.browser.close();
      console.log('Old browser closed');
    }
    return (this.break = true);
  };
}

module.exports = Twitter;
