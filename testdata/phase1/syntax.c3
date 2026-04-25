module phase1;

<* "User docs" *>
struct User @packed
{
    <* "Field docs" *>
    String name @required;
    int age;
}

union Value
{
    int i;
    double d;
}

bitstruct Flags : uint
{
    uint read : 0;
    uint write : 1;
}

enum Color : int
{
    RED,
    GREEN = 2,
    BLUE,
}

constdef ErrorCode : int
{
    OK = 0,
    FAIL = 1,
}

interface Reader
{
    fn void read(String path);
}

faultdef NOT_FOUND, DENIED;
typedef Name = String;
alias UserName = String;
attrdef @Route(String path);

int global_count;
extern fn void imported();

macro void trace(String msg)
{
}

fn int add(int a, int b)
{
    return a + b;
}
