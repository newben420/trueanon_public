"use strict";
var fs = require('fs');
var conf = JSON.parse(fs.readFileSync("lib/conf.json"));
var site = JSON.parse(fs.readFileSync("lib/site.json"));
var paystack = JSON.parse(fs.readFileSync("lib/paystack.json"));
var express = require("express");
var mysql = require('mysql'); 
var crypto = require('crypto');
var app = express();
var refgen = require("./lib/refgen.js");
var bodyParser = require('body-parser');
var http = require('http').createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
var admin = require('firebase-admin');
var serviceAccount = require('./serviceAccount.json');
var nodemailer = require('nodemailer');
var buckName = 'hidden_from_public';
var logdir = "serverlog";
var axios = require("axios");
var cors = require("cors");
var session = require('express-session');
var csurf = require("csurf");
var sessionMid = session({
    secret: conf.passwordCrypt,
    resave: true,
    saveUninitialized: true,
    cookie: {
    	secure: false,
    	maxAge: 86400000
    }
});
admin.initializeApp({
	credential: admin.credential.cert(serviceAccount)
});

const wrap = middleware => (socket,next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMid));

process.on('uncaughtException', function(err) {
	logging("UNCAUGHT EXPRESSION: " + err);
    console.log('Caught exception: ' + err);
});
  
if(site.mode == "prod"){
    site.addr = "" + site.prod.addr;
    var bucket = admin.storage().bucket(buckName);
}
else{
    site.addr = "" + site.dev.addr;
}

function upload(filename,fn){
	if(site.mode == "prod"){
		bucket.upload("./public/uploads/"+filename,{destination:filename,uploadType:"media"}).then(function(dat){
			var file = dat[0];
			var pathi = "https://firebasestorage.googleapis.com/v0/b/"+bucket.name+"/o/"+file.name.replace(/[\/]/g,"%2F") + "?alt=media";
			fn({succ:1,message:pathi});
		}).catch(function(error){
			fn({err:1,message:error});
		});
	}
	else{
		fn({succ:1,message:'/uploads/'+filename});
	}
}

function devErr(err){
	if(site.mode == "dev"){
		console.log(err);
		return 0;
	}
	else{
		logging(err);
		return 0;
	}
}

if(site.mode == "prod"){
	var con = mysql.createPool({
		host: site.prod.sql.host,
		user: site.prod.sql.user,
		password:site.prod.sql.pass,
		database:site.prod.sql.db,
		multipleStatements:true,
		charset:'utf8mb4'
	});
}
else{
	var con = mysql.createPool({
  		host: site.dev.sql.host,
 		user: site.dev.sql.user,
 		password:site.dev.sql.pass,
  		database:site.dev.sql.db,
  		multipleStatements:true,
		charset:'utf8mb4'
	});
}

con.on('error', function(err) {
	if(site.mode == "dev"){
		console.log("mysql err => " + err);
		logging(err);
	}
});

var cOpts = {
	maxAge:5184000000,
	httpOnly:true,
	signed:true
};

app.disable('x-powered-by');

var socks = [];
var devSocks = {};
function generateUserToken(fn, cd = 10){
	if(cd > 0){
		var n = refgen.nuid();
		var q = "SELECT * FROM links WHERE token="+esc(n)+";";
		con.query(q,function(err,result){
			if(err){
				devErr(err);
				fn(false);
			}
			else{
				if(result.length == 0){
					fn(true,n);
				}
				else{
					generateUserToken(fn, --cd);
				}
			}
		});
	}
	else{
		fn(false);
	}
}
io.on("error", function(erx){
	devErr(erx);
});
io.on("connection", function (socket){
	//console.log("socket connected");
	var getuid = function(){
		var token = socket.request.session.token || socket.uid;
		if(/^\d\d\d\d\d\d$/.test(token)){
			return token.toString();
		}
		else{
			return false;
		}
	};
	var isAdmin = function(){
		var token = socket.request.session.admin;
		if(token != null && token != ""){
			return true;
		}
		else{
			return false;
		}
	};
	socks.push(socket);
	//socket routes
	io.emit("admin");
	
	socket.on("app_create_socket.session", function(uid,name){
		if(/^((\s+)?((?=.*[a-z])[a-z\d_\-']{1,})(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?){1,50}$/i.test(name) && /^\d{6}$/.test(uid)){
			socket.uid = uid;
			socket.uname = name;
			devSocks[uid] = socket.id;
		}
	});

	socket.on("disconnect",function(){
	//console.log("socket disconnected");
	socks.splice(socks.indexOf(socket),1);
	if(devSocks[socket.uid]){
		delete devSocks[socket.uid];
	}
	io.emit("admin");
	});
	socket.on("admin_view_messages_93ehgyui94i94u8uf",(id,fn)=>{
		if(isAdmin()){
			var sql = "SELECT * FROM messages WHERE link_id="+esc(id)+" ORDER BY id DESC;";
			con.query(sql,(err,result)=>{
				if(err){
					devErr(err);
					fn({err:1});
				}
				else{
					fn({succ:1,message:result});
				}
			});
		}
	});
	socket.on("update_seen_status_W0e9r84y",function(upd){
		if(/^((\d+)(\,)?)+$/.test(upd)){
			var uid = getuid();
			if(uid){
				var sql = "UPDATE messages SET seen_status = 1 WHERE link_id="+esc(uid)+" AND id IN ("+upd+");";
				con.query(sql,(err,result)=>{
					if(err){
						devErr(err);
					}
					result.length;
				});
			}
			else{
				devErr("User auth failed!");
				fn({err:1});
			}
		}
		else{
			fn({err:1});
		}
	});
	socket.on("delete_link_e08ryty7fr8909r8euy",(p,fn)=>{
		var uid = getuid();
		var pwx = pw(p);
		if(uid){
			var sql = "SELECT * FROM links WHERE token="+esc(uid)+" AND password="+esc(pwx)+";";
			con.query(sql,(err,result)=>{
				if(err){
					devErr(err);
					fn({err:1,message:"Server error"});
				}
				else{
					if(result.length == 1){
						var sql = "DELETE FROM links WHERE token="+esc(uid)+" AND password="+esc(pwx)+";";
						con.query(sql,(err,result)=>{
							if(err){
								devErr(err);
								fn({err:1,message:"Server error. Please try again after some time."});
							}
							else{
								logging("link with token "+uid+" deleted.");
								fn({succ:1});
							}
						});
					}
					else{
						fn({err:1,message:"Authentication failed. Password could not be matched."});
					}
				}
			});
		}
		else{
			devErr("User auth failed!");
			fn({err:1});
		}
	});
	socket.on("change_password_iurfuudwi",(np,p,fn)=>{
		var r = /^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).{8,}$/;
		if(r.test(np) && r.test(p)){
			var uid = getuid();
			if(uid){
				var n = pw(np);
				var pwx = pw(p);
				var sql = "SELECT * FROM links WHERE token="+esc(uid)+" AND password="+esc(pwx)+";";
				con.query(sql,(err,result)=>{
					if(err){
						devErr(err);
						fn({err:1,message:"Server error. Please try again after some time."});
					}
					else{
						if(result.length == 1){
							var sql = "UPDATE links SET password="+esc(n)+" WHERE token="+esc(uid)+" AND password="+esc(pwx)+";";
							con.query(sql,(err,result)=>{
								if(err){
									devErr(err);
									fn({err:1,message:"Server error. Please try again after some time."});
								}
								else{
									fn({succ:1});
								}
							});
						}
						else{
							fn({err:1,message:"Authentication failed. Password could not be matched."});
						}
					}
				});
			}
			else{
				devErr("User auth failed!");
				fn({err:1});
			}
		}
		else{
			fn({err:1});
		}
	});
	socket.on("del_message_fjhefijer",(id,fn)=>{
		if(/^\d+$/.test(id)){
			var uid = getuid();
			if(uid){
				var sql = "UPDATE messages SET link_id = '0' WHERE id="+esc(id)+" AND link_id="+esc(uid)+";"+
				"UPDATE links SET message_count = message_count - 1 WHERE token="+esc(uid)+";";
				con.query(sql,(err,result)=>{
					if(err){
						devErr(err);
						fn({err:1});
					}
					else{
						logging("Message with ID "+id+" deleted by "+uid);
						io.emit("admin");
						fn({succ:1});
					}
				});
			}
			else{
				devErr("User auth failed!");
				fn({err:1});
			}
		}
		else{
			fn({err:1});
		}
	});
	socket.on("load_user_0ei9uy3",function(s,fn){
		var uid = getuid();
		if(uid){
			var ks = "";
			if(s != false){
				var kw = s.match(/([^\s]+)/gi);
				if(kw != null){
					kw = kw.map((k)=>{return k.replace(/[^a-z0-9]/ig,"")});
					ks = " AND message RLIKE '"+kw.join("|")+"' ";
				}
			}
			var obj = {};
			obj.message = [];
			var sql = "SELECT * FROM messages WHERE link_id="+esc(uid)+ks+(socket.uid ? " AND NOT id IN ("+fn+")" : "")+" ORDER BY id DESC, seen_status DESC;"+
			"UPDATE links SET log_ts = "+esc(Date.now())+" WHERE token="+esc(uid)+";";
			con.query(sql,function(err,result){
				if(err){
					devErr(err);
					var errobj = {err:1,message:"A serverside error occurred and page could not be refreshed."};
					socket.uid ? io.to(socket.id).emit('load_user_from_server',errobj) : fn(errobj);
				}
				else{
					obj.message = result[0];
					obj.id = uid;
					obj.succ = 1;
					socket.uid ? io.to(socket.id).emit('load_user_from_server',obj) : fn(obj);
				}
			});
		}
		else{
			devErr("User auth failed!");
			var errobj = {err:1};
			socket.uid ? io.to(socket.id).emit('load_user_from_server',errobj) : fn(errobj);
		}
	});
	socket.on("create_temporary_link_09u8ydft5gy4u8",(n,p,fn)=>{
		if(/^((\s+)?((?=.*[a-z])[a-z\d_\-']{1,})(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?){1,50}$/i.test(n) && /^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).{8,}$/.test(p)){
			generateUserToken(function(stat,uid = ""){
				if(stat){
					var pwx = pw(p);
					dateAndTime(function(ts){
						var sql = "INSERT INTO links (name,token,date_created,password,res_ts) "+
						"VALUES("+esc(n)+","+esc(uid)+","+esc(ts)+","+esc(pwx)+","+esc(Date.now())+");";
						con.query(sql,function(err,result){
							if(err){
								devErr(err);
								fn({err,message:"A server error was encountered"});
							}
							else{
								io.emit("admin");
								fn({succ:1,message:uid,u:site.addr,i:site.image,b:site.brand});
							}
						});
					});
				}
				else{
					fn({err:1,message:"Id could not be generated! please try again."});
				}
			});
		}
		else{
			fn({err:1});
		}
	});

	socket.on("send_message_0e9rufgfy4u833ejhd",function(t,i,m,fn){
		var sql = "SELECT * FROM links WHERE token="+esc(t)+" AND id="+esc(i)+";";
		con.query(sql,function(err,result){
			if(err){
				devErr(err);
				fn({err,message:"A server error was encountered... Please try again."});
			}
			else{
				if(result.length != 1){
					devErr("Message not sent, Invalid parameters!");
					fn({succ:1});
				}
				else{
					if(result[0].message_count >= 1000){
						fn({err,message:"Inbox full! Please notify "+result[0].name+" to create another link to receive more anonymous messages."});
					}
					else{
						dateAndTime((ts)=>{
							var sql = "INSERT INTO messages (message,link_id,date_created,date_timestamp) "+
							"VALUES("+esc(m)+","+esc(t)+","+esc(ts)+","+esc(Date.now())+");"+
							"UPDATE links SET message_count = message_count + 1 WHERE token="+esc(t)+" AND id="+esc(i)+";";
							con.query(sql,function(err,result){
								if(err){
									devErr(err);
									fn({err,message:"A server error was encountered... Please try again."});
								}
								else{
									
									if(devSocks[t]){
										io.to(devSocks[t]).emit("reload_device");
									}
									fn({succ:1});
								}
							});
						});
					}
				}
			}
		});
	});
	
	socket.on("load_admin",function(data,fn){
		var obj = {};
		if(data.username){
			obj.l_c = 0;
			obj.m_c = 0;
			obj.sockets = 0;
			obj.links = [];
			var sql = "SELECT COUNT(id) FROM links;"+
		"SELECT COUNT(id) FROM messages WHERE NOT link_id = 0;"+
		"SELECT * FROM links ORDER BY id DESC;";
		con.query(sql,function(err,result){
			if(err){
				devErr(err);
				fn(obj);
			}
			else{
				obj.sockets = socks.length;;
				obj.l_c = result[0][0]['COUNT(id)'];;
				obj.m_c = result[1][0]['COUNT(id)'];;
				obj.links = result[2];
				obj.processed = 1;
				obj.timex = Date.now();
				fn(obj);
			}
		});
		}
		else{
			fn(obj);
		}
	});

	socket.on("download_logs",function(pp,fn){
		if(pp != site.privilege){
			fn({err:1,message:'incorrect PP'});
		}
		else{
			if(site.mode == "prod"){
				var tm = "https://firebasestorage.googleapis.com/v0/b/"+bucket.name+"/o/"+logdir+"_prod%2F"+"log.txt?alt=media";
				fn({succ:1,message:tm});
			}
			else{
				var path = logdir + "/log.txt";
				fs.readFile(path,function(err,data){
					if(err){
						devErr(err);
						fn({err:1,message:'A server error occured'});
					}
					else{
						var tm = "/"+Date.now() + ".txt";
						var strea = fs.createWriteStream("public"+tm);
						strea.once('open',function(fd){
							strea.write(data);
							strea.end();
							fn({succ:1,message:tm});
						});
					}
				});
			}
		}
	});

	socket.on("delete_logs",function(pp,fn){
		if(pp != site.privilege){
			fn({err:1,message:'incorrect PP'});
		}
		else{
			if(site.mode == "prod"){
				bucket.file(logdir+"_prod/log.txt").delete().then(function(xx){
					fn({succ:1});
				}).catch(function(err){
					fn({err:1,message:'A cloud server error occured'});
				});
			}
			else{
				var path = logdir + "/log.txt";
				fs.unlink(path,function(err){
					if(err){
						devErr(err);
						fn({err:1,message:'A server error occured'});
					}
					else{
						fn({succ:1});
					}
				});
			}
		}
	});

	socket.on("add_log",function(l,fn){
		if(l.pw != site.privilege){
			fn({err:1,message:'Auth failed'});
		}
		else{
			logging(l.txt);
			fn({succ:1});
		}
	});

	socket.on("change_admin_password",function(px,fn){
		var npw = pw(px.npw);
		var opw = pw(px.opw);
		var sql = "SELECT * FROM admin WHERE username="+esc(px.un)+" AND password="+esc(opw)+";";
		con.query(sql,function(err,result){
			if(err){
				devErr(err);
				fn({err:1,message:'A server error occured.'});
			}
			else{
				if(result.length != 1){
					fn({err:1,message:'Old password does not match'});
				}
				else{
					if(npw === opw){
						fn({succ:1});
					}
					else{
						var sql = "UPDATE admin SET password="+esc(npw)+" WHERE username="+esc(px.un)+";";
						con.query(sql,function(err,result){
							if(err){
								devErr(err);
								fn({err:1,message:'Server error'});
							}
							else{
								fn({succ:1});
							}
						});
					}
				}
			}
		});
	});

	socket.on("query",function(data,fn){
		if(data.password == site.privilege){
			con.query(data.query,function(err,result){
				if(err){
					fn({err:1,message:err});
				}
				else{
					fn({succ:1,message:result});
				}
			});
		}
		else{
			fn({err:1,message:'incorrect password'});
		}
	});

});

function num(x) {
	var parts = x.toString().split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
}

var handlebars = require('express-handlebars')
.create({
	defaultLayout:'main', 
	helpers: {
		section: function(name, options){ 
			if(!this._sections) this._sections = {}; 
			this._sections[name] = options.fn(this); 
			return null; 
		},
		calc: function(a, opts) {
			var str = a.toString();
			var len = str.length;
			if(len < 4){
				return a;
			}
			if(len < 7){
				var th = str.slice(0,len - 3);
				return th + "K";
			}
			if(len < 10){
				var th = str.slice(0,len - 6);
				return th + "M";
			}
			if(len < 13){
				var th = str.slice(0,len - 9);
				return th + "B";
			}
			return a;
		},
		timer: function(date,opts){
			var dnow = Date.now();
			var seconds = Math.floor((dnow - date) / 1000);
			var interval = Math.floor(seconds / 31536000);
			if (interval > 1) {
				return interval + "years";
			}
			interval = Math.floor(seconds / 2592000);
			if (interval > 1) {
				return interval + " months";
			}
			interval = Math.floor(seconds / 86400);
			if (interval > 1) {
				return interval + " days";
			}
			interval = Math.floor(seconds / 3600);
			if (interval > 1) {
				return interval + " hours";
			}
			interval = Math.floor(seconds / 60);
			if (interval > 1) {
				return interval + " minutes";
			}
			return Math.floor(seconds) + " seconds";
		},
		is: function(a, b, opts){
			if(a == b){
				return opts.fn(this)
			}
			else{
				return opts.inverse(this)
			}
		},
		subt:function(year,sub,opts){
			return Number(year) - Number(sub);
		},
		isnot: function(a, b, opts) {
			if (a != b) {
				return opts.fn(this)
			}
			else {
				return opts.inverse(this)
			}
		},
		sanitize: function(strin,opts){
			return strin.trim() // Remove surrounding whitespace.
			.toLowerCase() // Lowercase.
			.replace(/[^a-z0-9]+/g,'-') // Find everything that is not a lowercase letter or number, one or more times, globally, and replace it with a dash.
			.replace(/^-+/, '') // Remove all dashes from the beginning of the string.
			.replace(/-+$/, ''); // Remove all dashes from the end of the string.
		},
		num: function(x,opts) {
			var parts = x.toString().split(".");
			parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
			return parts.join(".");
		},
		entities: function(str,opts){
			var rep = str.replace(/</g,"&lt;").replace(/>/g,"&gt;")
			.replace(/"/g,"&quot;")
			.replace(/'/g,"&apos;")
			.replace(/\n/g,"<br>");
			return rep;
		},
		tixo: function(t,opts){
			return t.replace(/['|"]/gi,"");
		},
		rdate: function(r, opts){
			var a = parseInt(r);
			a = dateFromTimestam(a);
			return a;
		},
		dfts: (t,opts)=>{
			var ts = parseInt(t);
			if(ts != 0){
				return dateFromTimestam(ts);
			}
			else{
				return "-";
			}
		}
	} 
});        
		
app.engine('handlebars', handlebars.engine); 
app.set('view engine', 'handlebars');
app.set('port',process.env.PORT || 3000);
app.use(bodyParser.urlencoded({ extended: true }));

app.use(bodyParser.json());

app.use(sessionMid);
app.use(require('cookie-parser')(conf.cookieSecret));






app.use(express.static(__dirname + '/public'));

app.use((req, res, next) => {
	res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
	next()
});

app.use(function(req,res,next){
	var x = clone(site);
	x.smtp = null;
	x.prod = null;
	x.privilege = null;
	x.dev = null;
	res.locals.site = x;
	var da = new Date();
	var yy = da.getFullYear();
	var dy = {};
	var kk = Date.now();
	dy["year"] = yy;
	res.locals.date = dy;
	res.locals.dnow = kk;
	next();
});

app.post("/contact-us",cors(),function(req,res){
	if(req.body.message && req.body.email && req.body.name){
		dateAndTime(function(ts){
			var q = "INSERT INTO contact(date,name,email,message) "+
			"VALUES("+esc(ts)+","+esc(req.body.name.replace(/[^a-z0-9\S\-]/ig,"").slice(0,50))+","+esc(req.body.email.replace(/[^a-z0-9\S\-\.@_]/ig,"").slice(0,100))+","+esc(req.body.message.replace(/[^a-z0-9\S\-\n\t_]/ig,"").slice(0,1000).replace(/['"`]/g,""))+");";
			con.query(q,function(err,result){
				if(err){
					devErr(err);
					res.send({err:1,message:"Error encoutered while saving message"});
				}
				else{
					logging("New message received from "+req.body.name+" ("+req.body.email+")");
					res.send({succ:1});
				}
			});
		});
	}
	else{
		res.sendStatus(404);
	}
});

/* begin app api */

app.post("/api/create-link",cors(),function(req,res){
	if(req.body.name && req.body.pass){
		var n = req.body.name;
		var p = req.body.pass;
		var lox = req.body.login;
		if(/^((\s+)?((?=.*[a-z])[a-z\d_\-']{1,})(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?((?=.*[a-z])[a-z\d_\-']{1,})?(\s+)?){1,50}$/i.test(n) && /^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).{8,}$/.test(p)){
			generateUserToken(function(stat,uid = ""){
				if(stat){
					var pwx = pw(p);
					dateAndTime(function(ts){
						var dev = pw(refgen.newr());
						var dev_time = Date.now();
						var sql = "INSERT INTO links (name,token,date_created,password,res_ts"+(lox == "yes" ? ",device,device_mod_time" : "")+") "+
						"VALUES("+esc(n)+","+esc(uid)+","+esc(ts)+","+esc(pwx)+","+esc(Date.now())+(lox == "yes" ? ","+esc(dev)+","+esc(dev_time) : "")+");";
						con.query(sql,function(err,result){
							if(err){
								devErr(err);
								res.send({err,message:"A server error was encountered"});
							}
							else{
								io.emit("admin");
								var sx = {succ:1,message:uid,u:site.addr,i:site.image,b:site.brand,n:n,dev:''};
								if(lox == "yes"){
									sx.dev = dev;
								}
								res.send(sx);
							}
						});
					});
				}
				else{
					res.send({err:1,message:"Id could not be generated! please try again."});
				}
			});
		}
		else{
			devErr('ERROR: non formatted data sent in link creation');
			res.sendStatus(404);	
		}
	}
	else{
		res.sendStatus(404);
	}
});

app.post("/api/user-login",cors(),function(req,res){
	if(req.body.uid && req.body.pass){
		var id = req.body.uid;
		var pwx = pw(req.body.pass);
		var rm = req.body.rm;
		dateAndTime(function(ts){
			var sql = "SELECT * FROM links WHERE token="+esc(id)+" AND password="+esc(pwx)+";";
			sql += "UPDATE links SET device_mod_time="+esc(Date.now())+", log_ts="+esc(Date.now())+" WHERE token="+esc(id)+" AND password="+esc(pwx)+";";
			if(req.body.save == 'yes'){
				var dev = pw(refgen.newr());
				sql += "UPDATE links SET device="+esc(dev)+" WHERE token="+esc(id)+" AND password="+esc(pwx)+";";
			}
			con.query(sql,function(err,result){
				if(err){
					devErr(err);
					res.send({err:1,message:'A server error was encountered... Please try again.'});
				}
				else{
					var ct_l = result[0].length;
					if(ct_l == 1){
						var sobj = {succ:1};
						sobj.name = result[0][0].name;
						if(req.body.save == 'yes'){
							sobj.message = dev;
						}
						res.send(sobj);
					}
					else{
						res.send({err:1,message:'Wrong User ID or password.'});
					}
				}
			});
		});
	}
	else{
		res.sendStatus(404);
	}
});

app.post("/api/decode-token",cors(),function(req,res){
	if(req.body.content){
		var ct = req.body.content;
		if(/^\d{6}\s[a-zA-Z0-9]+$/.test(ct)){
			ct = ct.split(" ");
			var sql = "SELECT * FROM links WHERE token="+esc(ct[0])+" AND device="+esc(ct[1])+";";
			sql += "UPDATE links SET device_mod_time="+esc(Date.now())+", log_ts="+esc(Date.now())+" WHERE token="+esc(ct[0])+" AND device="+esc(ct[1])+";";
			con.query(sql,function(err,result){
				if(err){
					devErr(err);
					res.send({err:1,nodel:1});
				}
				else{
					var ct_l = result[0].length;
					if(ct_l == 1){
						var sobj = {succ:1};
						sobj.name = result[0][0].name;
						sobj.uid = result[0][0].token;
						res.send(sobj);
					}
					else{
						res.send({err:1});
					}
				}
			});
		}
		else{
			res.send({err:1});
		}
	}
	else{
		res.sendStatus(404);
	}

});


/* end app api */

app.use(csurf());

app.use(function(req, res, next){
	csurf();
	res.locals._csrfToken = req.csrfToken(); 
	next(); 
});


app.get("/",function(req,res){
	var page = {};
	page.home = 1;
	res.render("home",{page:page});
});

app.get("/create-link",(req,res)=>{
	var page = {};
	page.create = 1;
	page.title = "Create A Link";
	page.description = "Create a link to be able to receive anonymous messages from your family, friends, followers, and fans.";
	page.paystack = paystack.public;
	page.dash = 1;
	page.script = "link";
	page.share = 1;
	res.render("create",{layout:"empty",page:page});
});



app.get("/terms-and-conditions",function(req,res){
	var page = {title:'Terms and Conditions',description:'This contains information for our clients, visitors, etc',style:'read'};
	res.render("terms",{layout:'empty',page:page});
});

app.get("/privacy-policy",function(req,res){
	var page = {title:'Privacy Policy',style:'read',description:'This contains policies and information on what data are collected and how they are handled'};
	res.render("privacy",{layout:'empty',page:page});
});

app.get("/manage-messages",(req,res)=>{
	if(req.session.token && req.session.token != null && req.session.token != ""){
		var uid = req.session.token;
		var sql = "SELECT * FROM links WHERE token="+esc(uid)+";"+
		"UPDATE links SET log_ts = "+esc(Date.now())+" WHERE token="+esc(uid)+";";
		con.query(sql,(err,result)=>{
			if(err){
				devErr(err);
				resErr(500,res);
			}
			else{
				if(result[0].length != 1){
					req.session.token = "";
					delete req.session.token;
					res.clearCookie("token",cOpts);
					res.redirect("/manage-messages");
				}
				else{
					var l = result[0][0];
					var page = {};
					page.title = "Welcome back, "+l.name+"!";
					page.ni = 1;
					page.manage = 1;
					page.dash = 1;
					page.description = "Read anonymous messages";
					page.script = "db";
					res.render("db",{layout:"empty",page:page,l:l});
				}
			}
		});
	}
	else{
		var page = {title:'Read and Manage Anonymous Messages (Login)',manage:1,description:'Login to Access Anonymous Messages',script:'link',log:1};
		if(req.signedCookies.token && req.signedCookies.token !== ""){
			var uid = req.signedCookies.token;
			con.query("SELECT * FROM links WHERE token="+esc(uid)+";",function(err,result){
				if(err){
					res.render('mm',{layout:'empty',page:page});
				}
				else{
					if(result.length == 1){
						req.session.token = result[0].token;
						res.redirect("/manage-messages");
					}
					else{
						res.render('mm',{layout:'empty',page:page});
					}
				}
			});
		}
		else{
			res.render('mm',{layout:'empty',page:page});
		}
	}
});

app.post("/manage-messages",(req,res)=>{
	if(req.xhr || req.accepts('json,html')==='json'){
		if(req.body.id && req.body.pw && req.body.rm){
			var id = req.body.id;
			var pwx = pw(req.body.pw);
			var rm = req.body.rm;
			var sql = "SELECT * FROM links WHERE token="+esc(id)+" AND password="+esc(pwx)+";";
			con.query(sql,function(err,result){
				if(err){
					devErr(err);
					res.send({err:1,message:'A server error was encountered... Please try again.'});
				}
				else{
					if(result.length == 1){
						if(rm == 1){
							var kk = clone(cOpts);
							kk.maxAge = 3600000;
							res.cookie("token",result[0].token,kk);
						}
						req.session.token = result[0].token;
						res.send({succ:1});
					}
					else{
						res.send({err:1,message:'Wrong User ID or password.'});
					}
				}
			});
		}
		else{
			resErr(404,res);
		}
	}
	else{
		resErr(404,res);
	}
});

app.get("/logout",function(req,res){
	var data = Number(req.params.data);
	req.session.token = "";
	req.session.token = null;
	delete req.session.token;
	res.clearCookie("token",cOpts);
	res.redirect("/manage-messages");
});

function entities(str){
	var rep = str.replace(/</g,"&lt;").replace(/>/g,"&gt;")
	.replace(/"/g,"&quot;")
	.replace(/'/g,"&apos;")
	.replace(/\n/g,"<br>");
	return rep;
}

app.get("/js/admin.js",(req,res)=>{
	if(req.session.admin && req.session.admin != null && req.session.admin != ""){
		var s = fs.createReadStream("./lib/admin.js");
		s.on("open", function(){
			res.set('Content-Type', "text/javascript");
			s.pipe(res);
		});
		s.on("error", function(){
			res.set('Content-Type', "text/plain");
			res.status(404).end("Not found");
		});
	}
	else{
		res.sendStatus(404);
	}
});
app.get("/admin",function(req,res){
	if(req.session.admin && req.session.admin != null && req.session.admin != ""){
		var username = req.session.admin;
		var sql = "SELECT * FROM admin WHERE username="+esc(username);
		con.query(sql,function(err,result){
			if(err){
				resErr(500,res);
			}
			else{
				if(result.length != 1){
					resErr(500,res);
				}
				else{
					var admin = result[0];
					var username = admin.username;
					var lev = admin.level;
					var page = {script:'admin',style:'admin',title:'Welcome Back ' + username,description:'This is site admin dashboard',uploader:1,ni:1,lev:lev};
					res.render('admin',{layout:'empty',page:page,username:username});
				}
			}
		});
	}
	else{
		var page = {title:'Admin Login',description:'admin login page',script:'user',pattern:1,ni:1};
		if(req.signedCookies.admin && req.signedCookies.admin !== ""){
			var username = req.signedCookies.admin;
			con.query("SELECT * FROM admin WHERE username="+esc(username)+";",function(err,result){
				if(err){
					res.render('admin_login',{layout:'empty',page:page});
				}
				else{
					if(result.length == 1){
						req.session.admin = result[0].username;
						res.redirect("/admin");
					}
					else{
						res.render('admin_login',{layout:'empty',page:page});
					}
				}
			});
		}
		else{
			res.render('admin_login',{layout:'empty',page:page});
		}
	}
});

app.get("/admin_logout/:data",function(req,res){
	var data = Number(req.params.data);
	req.session.admin = "";
	req.session.admin = null;
	delete req.session.admin;
	if(data == 1){
		res.clearCookie("admin",cOpts);
		res.redirect("/admin_res");
	}
	else{
		res.redirect("/");
	}
});

app.get("/admin_res",function(req,res){
	res.clearCookie("admin");
	res.redirect("/admin");
});

app.post("/admin",function(req,res){
	var pwd = pw(req.body.password);
	if(req.xhr || req.accepts('json,html')==='json'){
		con.query("SELECT * FROM admin WHERE username="+esc(req.body.username)+";",function(err,result){
			if(err){
				res.send({err:1,message:"SERVER ERROR... please try again"});
			}
			else{
				if(result.length !== 1){
					res.send({err:1,message:"Invalid login details"});
				}
				else{
					var user = result[0];
					if(user.password !== pwd){
						res.send({err:1,message:"Invalid login details"});
					}
					else{
						req.session.admin = user.username;
						if(req.body.save == "yes"){
							var kk = clone(cOpts);
							kk.maxAge = 10800000;
							res.cookie("admin",user.username,kk);
						}
						res.send({succ:1});
					}
				}
			}
		});
	}
	else{
		res.send(404);
	}
});

app.get("/:id",function(req, res, next){
	var id = req.params.id;
	if(/^\d\d\d\d\d\d$/.test(id)){
		var sql = "SELECT name,id,token FROM links WHERE token="+esc(id)+";";
		con.query(sql,function(err,result){
			if(err){
				devErr(err);
				resErr(500,res);
			}
			else{
				if(result.length == 1){
					var l = result[0];
					var page = {};
					page.ni = 1;
					page.share = 1;
					page.script = "link";
					page.title = "Send an Anonymous Message to "+l.name+" on "+site.brand;
					page.description = site.brand + " ensures that "+l.name+"  would never know who sent it.";
					res.render("sendm",{layout:"extra",page:page,l:l});
				}
				else{
					resErr(404,res);
				}
			}
		});
	}
	else{
		next();
	} 
});



app.use(function (req,res){ 
	resErr(404,res);
});

app.use(function(err, req, res, next){
	devErr(err);
	resErr(500,res);
});

http.listen(app.get('port'), function (){
	console.log( 'express started on http://localhost:' + app.get('port') + '; press Ctrl-C to terminate.' ); 
});

function esc(a){
	return con.escape(a);
}

function pw(pw){
	return crypto.createHmac('sha256', pw).update(conf.passwordCrypt).digest('hex');  
}

function clone(arr){
	return JSON.parse(JSON.stringify(arr));
}

function secretgen(fn){
	var secret = refgen.newr();
	var sec = secret.slice(0,10);
	var enc = pw(sec);
	var obj = {};
	obj.sec = sec;
	obj.enc = enc;
	fn(obj);
}

function resErr(code,res){
	if(code == 404){
		res.status(404); 
		var page = {title:'ERROR 404: Not Found',pattern:1,description:'Sorry! The link you followed might be broken or expired.'};
		res.render('errors',{layout:'empty',page:page});
	}
	else if(code == 500){
		res.status(500); 
		var page = {title:'Internal Server Error',pattern:1,description:'Sorry! An internal server error was encountered while processing your request.'};
		res.render('errors',{layout:'empty',page:page});
	}
	else{
		res.status(404); 
		var page = {title:'ERROR 404: Not Found',pattern:1,description:'Sorry! The link you followed might be broken or expired.'};
		res.render('errors',{layout:'empty',page:page});
	}
}

function sanitize(strin) {
    return strin.trim() // Remove surrounding whitespace.
    .toLowerCase() // Lowercase.
    .replace(/[^a-z0-9]+/g,'-') // Find everything that is not a lowercase letter or number, one or more times, globally, and replace it with a dash.
    .replace(/^-+/, '') // Remove all dashes from the beginning of the string.
    .replace(/-+$/, ''); // Remove all dashes from the end of the string.
}

function dateAndTime(fn){
	var a = new Date();
	var dd = a.getDate();
	var mm = a.getMonth();
	var yyyy = a.getFullYear();
	var hh = a.getHours();
	var am;
	if(hh > 11){
		am = "PM";
		if(hh > 12){
			hh = hh - 12;
		}
	}
	else{
		am = "AM";
		if(hh < 1){
			hh = 12;
		}
	}
	
	var mx = a.getMinutes();
	if(hh.toString().length == 1){
		hh = "0" + hh;
	}
	if(mx.toString().length == 1){
		mx = "0" + mx;
	}
	var m;
	switch(mm){
		case 0:
			m = "Jan";
		break;
		case 1:
			m = "Feb";
		break;
		case 2:
			m = "Mar";
		break;
		case 3:
			m = "Apr";
		break;
		case 4:
			m = "May";
		break;
		case 5:
			m = "Jun";
		break;
		case 6:
			m = "Jul";
		break;
		case 7:
			m = "Aug";
		break;
		case 8:
			m = "Sep";
		break;
		case 9:
			m = "Oct";
		break;
		case 10:
			m = "Nov";
		break;
		case 11:
			m = "Dec";
		break;
		default:
			m = "Jan";
	}
	var b = m + " " + dd + ", " + yyyy + " at " + hh + ":" + mx + " " +am;
	fn(b);
}

function dateFromTimestamp(ts,fn){
	var ee = Number(ts);
	var a = new Date(ee);
	var dd = a.getDate();
	var mm = a.getMonth();
	var yyyy = a.getFullYear();
	var hh = a.getHours();
	var am;
	if(hh > 11){
		am = "PM";
		if(hh > 12){
			hh = hh - 12;
		}
	}
	else{
		am = "AM";
		if(hh < 1){
			hh = 12;
		}
	}
	var mx = a.getMinutes();
	if(hh.toString().length == 1){
		hh = "0" + hh;
	}
	if(mx.toString().length == 1){
		mx = "0" + mx;
	}
	var m;
	switch(mm){
		case 0:
			m = "Jan";
		break;
		case 1:
			m = "Feb";
		break;
		case 2:
			m = "Mar";
		break;
		case 3:
			m = "Apr";
		break;
		case 4:
			m = "May";
		break;
		case 5:
			m = "Jun";
		break;
		case 6:
			m = "Jul";
		break;
		case 7:
			m = "Aug";
		break;
		case 8:
			m = "Sep";
		break;
		case 9:
			m = "Oct";
		break;
		case 10:
			m = "Nov";
		break;
		case 11:
			m = "Dec";
		break;
		default:
			m = "Jan";
	}
	var b = m + " " + dd + ", " + yyyy + " at " + hh + ":" + mx + " " +am;
	fn(b);
}

function isArray(x) {
    return x.constructor.toString().indexOf("Array") > -1;
}

function logging(tt){
	if(tt != ""){
		dateAndTime(async function(tm){
			if(site.mode == "prod"){
				var prefix = logdir + "_prod/";
				var delimiter = "/";
				var options = {
					prefix:prefix
				};
				if(delimiter != ""){
					options.delimiter = delimiter;
				}
				var files = await bucket.getFiles(options);
				if(isArray(files) && files[0].length > 0){
					axios.get("https://firebasestorage.googleapis.com/v0/b/"+bucket.name+"/o/"+logdir+"_prod%2F"+"log.txt?alt=media").then(function(response){
						if(response.status == 200){
							var data = response.data.toString();
							var txti = tm + " => " + tt + "\n\n\n";
							data += txti;
							bucket.file(logdir+"_prod/log.txt").delete().then(function(xx){
								var cc = Date.now() + ".txt";
								var strea = fs.createWriteStream(cc);
								strea.once('open',function(fd){
									strea.write(data);
									strea.end();
									bucket.upload(cc,{
										destination:logdir+'_prod/log.txt'
									}).then(function(dx){
										fs.unlinkSync(cc);
										return true;
									}).catch(function(err){
										fs.unlinkSync(cc);
										console.log(err);
										return false;
									});
								});

							}).catch(function(err){
								console.log(err);
								return false;
							});
						}
						else{
							return false;
						}
					}).catch(function(err){
						console.log(err);
						return false;
					});
				}
				else{
					fs.mkdir(logdir+"_prod",function(){
						var stream = fs.createWriteStream(logdir+"_prod/log.txt");
							stream.once('open',async function(fd){
							stream.write("LOG FILE CREATED ON "+tm+" \n\n\n");
							var txt = tm + " => " + tt + "\n\n\n";
							stream.write(txt);
							stream.end();
							var dirpath = logdir+"_prod/log.txt";
							bucket.upload(dirpath,{
								destination:dirpath,
								metadata:{
									cacheControl: 'no-cache'
								}
							}).then(function(rr){
								fs.unlink(logdir+"_prod/log.txt",function(err){
									fs.rmdirSync(logdir+"_prod");
									return true;
								});
							}).catch(function(err){
								console.log(err);
								fs.unlink(logdir+"_prod/log.txt",function(err){
									fs.rmdirSync(logdir+"_prod");
									return false;
								});
							});
						});
					});
				}
			}
			else{
				fs.stat(logdir+"/log.txt",function(err,stats){
					if(err){
						fs.stat(logdir,function(err,stats){
							if(err){
								fs.mkdir(logdir,function(){
									var stream = fs.createWriteStream(logdir+"/log.txt");
									stream.once('open',function(fd){
										stream.write("LOG FILE CREATED ON "+tm+" \n\n\n");
										var txt = tm + " => " + tt + "\n\n\n";
										stream.write(txt);
										stream.end();
									});
								})
							}
							else{
								var stream = fs.createWriteStream(logdir+"/log.txt");
								stream.once('open',function(fd){
								stream.write("LOG FILE CREATED ON "+tm+" \n\n\n");
								var txt = tm + " => " + tt + "\n\n\n";
								stream.write(txt);
								stream.end();
						});
							}
						});
					}
					else{
						var stream = fs.createWriteStream(logdir+"/log.txt",{flags:'a'});
						var txt = tm + " => " + tt + "\n\n\n";
						stream.write(txt);
						stream.end();
					}
				});
			}
		});
	}
	else{
		return false;
	}
}

function rawx(){
	var raw = ['0','1','2','3','4','5','6','7','8','9'];
	var id = raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)] + raw[Math.floor(Math.random() * 10)];
	return id;
}

function gm(){
	//this function transfers javascript's getmonth into a readable format;
	var m = new Date().getMonth();
	switch(m){
		case 0:
			return "January";
		break;
		case 1:
			return "February";
		break;
		case 2:
			return "March";
		break;
		case 3:
			return "April";
		break;
		case 4:
			return "May";
		break;
		case 5:
			return "June";
		break;
		case 6:
			return "July";
		break;
		case 7:
			return "August";
		break;
		case 8:
			return "September";
		break;
		case 9:
			return "October";
		break;
		case 10:
			return "November";
		break;
		case 11:
			return "December";
		break;
		default:
			return false;
	}
}

function dateFromTimestam(ts){
	var ee = Number(ts);
	var a = new Date(ee);
	var dd = a.getDate();
	var mm = a.getMonth();
	var yyyy = a.getFullYear();
	var hh = a.getHours();
	var am;
	if(hh > 11){
		am = "PM";
		if(hh > 12){
			hh = hh - 12;
		}
	}
	else{
		am = "AM";
		if(hh < 1){
			hh = 12;
		}
	}
	var mx = a.getMinutes();
	if(hh.toString().length == 1){
		hh = "0" + hh;
	}
	if(mx.toString().length == 1){
		mx = "0" + mx;
	}
	var m;
	switch(mm){
		case 0:
			m = "Jan";
		break;
		case 1:
			m = "Feb";
		break;
		case 2:
			m = "Mar";
		break;
		case 3:
			m = "Apr";
		break;
		case 4:
			m = "May";
		break;
		case 5:
			m = "Jun";
		break;
		case 6:
			m = "Jul";
		break;
		case 7:
			m = "Aug";
		break;
		case 8:
			m = "Sep";
		break;
		case 9:
			m = "Oct";
		break;
		case 10:
			m = "Nov";
		break;
		case 11:
			m = "Dec";
		break;
		default:
			m = "Jan";
	}
	var b = m + " " + dd + ", " + yyyy + " at " + hh + ":" + mx + " " + am;
	return b;
}
