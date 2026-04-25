module http_demo;

import std::io;

struct HttpResponse
{
    String body;
}

fn void read_response(HttpResponse* res)
{
    io::printn(res.body);
}

fn int main(String[] args)
{
    HttpResponse res;
    read_response(&res);
    return 0;
}